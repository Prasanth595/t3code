import { useAtomValue } from "@effect/atom-react";
import { isSiblingOfPage } from "@t3tools/client-runtime/rpc/siblingCredentials";
import { EnvironmentAuthInvalidReason } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { useAtomCommand } from "../state/use-atom-command";
import { primaryServerConfigAtom } from "../state/server";
import { useEnvironments } from "../state/environments";
import { connectPairing as connectPairingAtom } from "./onboarding";
import { browserKeyProof } from "./browserKeyProof";

/**
 * Fork: Cloudflare Access login for sibling environments. The page's own
 * server lists its siblings in `trustedBrowserOrigins`. For each sibling that
 * is not saved yet, the page asks the sibling for a pairing credential with
 * its Cloudflare cookie, then adds it through the normal pairing path.
 *
 * Limit: "not saved yet" also covers a sibling that the user removed, so a
 * removed sibling comes back on the next load. Revisit when a user wants to
 * hide a sibling without removing it from `trustedBrowserOrigins`.
 *
 * MM-922: the bearer of a browser client's sibling lasts 1 day and is not bound
 * to the browser key. When a saved sibling refuses it, the page pairs again with
 * its key, with a backoff per sibling, so a refusal never loops. Revisit when
 * upstream gives DPoP a bootstrap source that is not the T3 Connect cloud
 * session; then siblings can use key-bound DPoP tokens instead.
 */

export const CLOUDFLARE_ACCESS_PAIRING_PATH = "/api/auth/cloudflare-access/pairing-credential";

/** Trusted sibling origins of the page that no saved environment points at. */
export function missingSiblingOrigins(input: {
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly savedUrls: ReadonlyArray<string | null>;
  readonly page: { readonly protocol: string; readonly hostname: string } | undefined;
}): ReadonlyArray<string> {
  const saved = new Set(
    input.savedUrls.flatMap((url) => {
      const origin = url === null ? undefined : URL.parse(url)?.origin;
      return origin === undefined ? [] : [origin];
    }),
  );
  return input.trustedOrigins.filter(
    (origin) => !saved.has(origin) && isSiblingOfPage(origin, input.page),
  );
}

/**
 * A one-use pairing credential from a sibling, or an error when Access has no cookie yet. The
 * machine map sends `omit`: the desktop app adds the machine token headers to the request, and
 * the target allows the desktop origin only without credentials.
 */
export async function requestSiblingPairingCredential(
  origin: string,
  credentials: RequestCredentials = "include",
): Promise<string> {
  const url = `${origin}${CLOUDFLARE_ACCESS_PAIRING_PATH}`;
  // MM-917: the machine finds the client of this browser by its key. The desktop app pairs with
  // its machine token instead, so it sends no proof.
  const proof = credentials === "include" ? await browserKeyProof("POST", url) : null;
  const response = await fetch(url, {
    method: "POST",
    credentials,
    ...(proof === null ? {} : { headers: { dpop: proof } }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const refusal = decodeRefusal(body);
    throw new SiblingPairingRefused(
      `${origin} answered ${response.status}.`,
      Option.isSome(refusal) ? refusal.value.reason : null,
    );
  }
  const body: unknown = await response.json();
  const credential =
    typeof body === "object" && body !== null && "credential" in body ? body.credential : null;
  if (typeof credential !== "string" || credential.length === 0) {
    throw new Error(`${origin} sent no pairing credential.`);
  }
  return credential;
}

/** A sibling refused a pairing credential. `reason` is its auth reason, when it sent one. */
class SiblingPairingRefused extends Error {
  override readonly name = "SiblingPairingRefused";
  constructor(
    message: string,
    readonly reason: EnvironmentAuthInvalidReason | null,
  ) {
    super(message);
  }
}
const decodeRefusal = Schema.decodeUnknownOption(
  Schema.Struct({ reason: EnvironmentAuthInvalidReason }),
);

/**
 * Trusted siblings of the page to pair: the ones no saved environment points at, and the saved
 * ones whose connection is refused, for example after their 1-day session ended (MM-922). A
 * paused sibling only reconnects, so it is not in the list (MM-718).
 */
function siblingOriginsToPair(input: {
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly environments: ReadonlyArray<{
    readonly displayUrl: string | null;
    readonly connection: { readonly phase: string };
  }>;
  readonly page: { readonly protocol: string; readonly hostname: string } | undefined;
}): ReadonlyArray<string> {
  const refused = new Set(
    input.environments.flatMap((environment) => {
      if (environment.connection.phase !== "error" || environment.displayUrl === null) return [];
      const origin = URL.parse(environment.displayUrl)?.origin;
      return origin === undefined ? [] : [origin];
    }),
  );
  return [
    ...missingSiblingOrigins({
      trustedOrigins: input.trustedOrigins,
      savedUrls: input.environments.map((environment) => environment.displayUrl),
      page: input.page,
    }),
    ...input.trustedOrigins.filter(
      (origin) => refused.has(origin) && isSiblingOfPage(origin, input.page),
    ),
  ];
}

/** Why a sibling is not paired, for the rows in Connections settings. */
export type SiblingIssue =
  | "sign-in" // most often no Cloudflare Access cookie for that host yet
  | "waiting" // MM-918: the browser key waits for approval in the portal
  | "paused"; // MM-718

const issueOf = (error: unknown): SiblingIssue =>
  error instanceof SiblingPairingRefused && error.reason === "client_pending"
    ? "waiting"
    : error instanceof SiblingPairingRefused && error.reason === "machine_paused"
      ? "paused"
      : "sign-in";

let issues: ReadonlyMap<string, SiblingIssue> = new Map();
const listeners = new Set<() => void>();
const setIssues = (next: ReadonlyMap<string, SiblingIssue>) => {
  issues = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useSiblingIssues = (): ReadonlyMap<string, SiblingIssue> =>
  useSyncExternalStore(subscribe, () => issues);

const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
const WAITING_CHECK_MS = 60_000;
/** After a pairing that worked, the next one for that sibling waits at least this long. */
const AFTER_SUCCESS_MS = 10 * 60_000;

const inFlight = new Set<string>();
// Per sibling: no attempt before `atMs`; `failures` grows the backoff.
const nextAttempt = new Map<string, { readonly atMs: number; readonly failures: number }>();

const delayAfter = (issue: SiblingIssue, failures: number): number => {
  if (issue === "waiting") return WAITING_CHECK_MS;
  if (issue === "paused") return RETRY_MAX_MS;
  return Math.min(RETRY_MIN_MS * 2 ** failures, RETRY_MAX_MS);
};

/**
 * Pairs the siblings of `siblingOriginsToPair` on load, on focus, when a sibling's connection is
 * refused, and once a minute, each one only after its backoff.
 */
export function useSiblingEnvironmentAutoPair(): void {
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const { isReady, environments } = useEnvironments();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const trustedOrigins = serverConfig?.trustedBrowserOrigins;
  const refusedKey = environments
    .filter((environment) => environment.connection.phase === "error")
    .map((environment) => environment.environmentId)
    .join(",");

  const pairSiblings = useEffectEvent(async () => {
    if (!isReady || trustedOrigins === undefined) return;
    const nowMs = Date.now();
    const due = siblingOriginsToPair({ trustedOrigins, environments, page: globalThis.location })
      .filter((origin) => !inFlight.has(origin))
      .filter((origin) => (nextAttempt.get(origin)?.atMs ?? 0) <= nowMs);
    if (due.length === 0) return;
    const next = new Map(issues);
    await Promise.all(
      due.map(async (origin) => {
        inFlight.add(origin);
        try {
          const pairingCode = await requestSiblingPairingCredential(origin);
          const result = await connectPairing({ host: origin, pairingCode });
          if (result._tag === "Failure") throw new Error(`Pairing with ${origin} failed.`);
          next.delete(origin);
          nextAttempt.set(origin, { atMs: Date.now() + AFTER_SUCCESS_MS, failures: 0 });
        } catch (error) {
          const issue = issueOf(error);
          const failures = (nextAttempt.get(origin)?.failures ?? 0) + 1;
          console.warn("Could not pair sibling environment.", origin, issue, error);
          next.set(origin, issue);
          nextAttempt.set(origin, { atMs: Date.now() + delayAfter(issue, failures), failures });
        } finally {
          inFlight.delete(origin);
        }
      }),
    );
    setIssues(next);
  });

  useEffect(() => {
    void pairSiblings();
  }, [isReady, trustedOrigins, environments.length, refusedKey]);

  useEffect(() => {
    const onFocus = () => void pairSiblings();
    globalThis.addEventListener("focus", onFocus);
    // A waiting key gets approved without any event on this page.
    const timer = globalThis.setInterval(() => void pairSiblings(), WAITING_CHECK_MS);
    return () => {
      globalThis.removeEventListener("focus", onFocus);
      globalThis.clearInterval(timer);
    };
  }, []);
}

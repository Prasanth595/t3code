import { useAtomValue } from "@effect/atom-react";
import { isSiblingOfPage } from "@t3tools/client-runtime/rpc/siblingCredentials";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { useAtomCommand } from "../state/use-atom-command";
import { primaryServerConfigAtom } from "../state/server";
import { useEnvironments } from "../state/environments";
import { connectPairing as connectPairingAtom } from "./onboarding";

/**
 * Fork: Cloudflare Access login for sibling environments. The page's own
 * server lists its siblings in `trustedBrowserOrigins`. For each sibling that
 * is not saved yet, the page asks the sibling for a pairing credential with
 * its Cloudflare cookie, then adds it through the normal pairing path.
 *
 * Limit: "not saved yet" also covers a sibling that the user removed, so a
 * removed sibling comes back on the next load. Revisit when a user wants to
 * hide a sibling without removing it from `trustedBrowserOrigins`.
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
  const response = await fetch(`${origin}${CLOUDFLARE_ACCESS_PAIRING_PATH}`, {
    method: "POST",
    credentials,
  });
  if (!response.ok) {
    throw new Error(`${origin} answered ${response.status}.`);
  }
  const body: unknown = await response.json();
  const credential =
    typeof body === "object" && body !== null && "credential" in body ? body.credential : null;
  if (typeof credential !== "string" || credential.length === 0) {
    throw new Error(`${origin} sent no pairing credential.`);
  }
  return credential;
}

// Siblings whose last attempt failed, most often because the browser holds no
// Cloudflare cookie for that host yet. Connections settings show them.
let signInNeeded: ReadonlyArray<string> = [];
const listeners = new Set<() => void>();
const setSignInNeeded = (origins: ReadonlyArray<string>) => {
  signInNeeded = origins;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useSiblingSignInNeeded = (): ReadonlyArray<string> =>
  useSyncExternalStore(subscribe, () => signInNeeded);

const inFlight = new Set<string>();

/** Adds missing sibling environments on load and again when the window gets focus. */
export function useSiblingEnvironmentAutoPair(): void {
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const { isReady, environments } = useEnvironments();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const trustedOrigins = serverConfig?.trustedBrowserOrigins;

  const pairMissing = useEffectEvent(async () => {
    if (!isReady || trustedOrigins === undefined) return;
    const missing = missingSiblingOrigins({
      trustedOrigins,
      savedUrls: environments.map((environment) => environment.displayUrl),
      page: globalThis.location,
    });
    const failed: Array<string> = [];
    await Promise.all(
      missing
        .filter((origin) => !inFlight.has(origin))
        .map(async (origin) => {
          inFlight.add(origin);
          try {
            const pairingCode = await requestSiblingPairingCredential(origin);
            const result = await connectPairing({ host: origin, pairingCode });
            if (result._tag === "Failure") throw new Error(`Pairing with ${origin} failed.`);
          } catch (error) {
            console.warn("Could not add sibling environment.", origin, error);
            failed.push(origin);
          } finally {
            inFlight.delete(origin);
          }
        }),
    );
    setSignInNeeded(failed);
  });

  useEffect(() => {
    void pairMissing();
  }, [isReady, trustedOrigins, environments.length]);

  useEffect(() => {
    const onFocus = () => void pairMissing();
    globalThis.addEventListener("focus", onFocus);
    return () => globalThis.removeEventListener("focus", onFocus);
  }, []);
}

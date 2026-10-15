/**
 * Fork: machine map. What an owner browser that signs in through Cloudflare Access gets, by the
 * `clientAccess` mode (MM-916 to MM-918). `EnvironmentAuth` calls it from its Access hook.
 */
import {
  AuthSettingsWriteScope,
  type AuthSessionState,
  clientKeyCode,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import { verifyRequestDpopProof } from "../../auth/dpop.ts";
import { deriveAuthClientMetadata } from "../../auth/utils.ts";
import { isLocalDesktopSubject, type MachineGrant } from "./machineAccess.ts";
import type * as MachineMapState from "./MachineMapState.ts";

/** MM-918: a browser that `enforce` refuses until the owner approves its key. */
export interface ClientPending {
  readonly _tag: "ClientPending";
  readonly pending: NonNullable<AuthSessionState["clientPending"]>;
}

export type OwnerBrowserAccess =
  | { readonly _tag: "owner" }
  | { readonly _tag: "client"; readonly grant: MachineGrant }
  | ClientPending;

const OWNER: OwnerBrowserAccess = { _tag: "owner" };

// Once per reason, so a proof that never verifies, for example a URL that the tunnel rewrites,
// shows in the log without a line per sign-in.
const loggedProofFailures = new Set<string>();

/**
 * MM-917, MM-918: an owner browser that proves its key gets the arrow of its client. The proof is
 * read only while `clientAccess` is not `off`, so `off` stays the owner login of MM-308. Under
 * `observe`, a missing or bad proof or an unknown key keeps the owner login; under `enforce`, it
 * gets nothing and waits for approval.
 *
 * Known limit: an owner subject that is not an email is the desktop service token for remote
 * machines (docs/fork.md), so it keeps the owner login. Revisit when that token is retired.
 */
export const ownerBrowserAccess = (
  machineMap: Option.Option<MachineMapState.MachineMapState["Service"]>,
  request: HttpServerRequest.HttpServerRequest,
  subject: string,
) => {
  if (Option.isNone(machineMap)) return Effect.succeed(OWNER);
  const map = machineMap.value;
  return map.browserKeyPolicy.pipe(
    Effect.flatMap(({ mode, portalUrl }) => {
      if (mode === "off" || (mode === "enforce" && !subject.includes("@"))) {
        return Effect.succeed(OWNER);
      }
      const refused = (code: string | null): OwnerBrowserAccess =>
        mode === "enforce" ? { _tag: "ClientPending", pending: { code, portalUrl } } : OWNER;
      if (request.headers.dpop === undefined) return Effect.succeed(refused(null));
      return verifyRequestDpopProof({ request }).pipe(
        Effect.flatMap((thumbprint) => {
          const client = deriveAuthClientMetadata({ request });
          return map
            .browserGrant({
              thumbprint,
              subject,
              describedAs: [client.browser, client.os].filter(Boolean).join(" on "),
            })
            .pipe(
              Effect.map((grant): OwnerBrowserAccess =>
                grant === undefined
                  ? refused(clientKeyCode(thumbprint))
                  : { _tag: "client", grant },
              ),
            );
        }),
        Effect.catch((error) => {
          const reason =
            error._tag === "ServerAuthInvalidCredentialError"
              ? (error.dpopFailureReason ?? error.diagnostic ?? "invalid")
              : error._tag;
          if (loggedProofFailures.has(reason)) return Effect.succeed(refused(null));
          loggedProofFailures.add(reason);
          return Effect.logWarning("Machine map could not verify a browser key proof.", {
            reason,
          }).pipe(Effect.as(refused(null)));
        }),
      );
    }),
  );
};

/**
 * MM-919: only the local desktop app changes `clientAccess` on this machine. It is the way back in
 * when `enforce` locks every browser out, so each such change is logged; the portal then reports
 * the local change (MM-404) and sends a push message.
 */
export const guardClientAccessPatch = (
  patch: { readonly clientAccess?: string },
  subject: string,
): Effect.Effect<void, EnvironmentAuthorizationError> => {
  if (patch.clientAccess === undefined) return Effect.void;
  if (!isLocalDesktopSubject(subject)) {
    return Effect.fail(
      new EnvironmentAuthorizationError({
        message: "Only the local desktop app or the machine map portal changes clientAccess.",
        requiredScope: AuthSettingsWriteScope,
      }),
    );
  }
  return Effect.logWarning("The local desktop app changed clientAccess.", {
    clientAccess: patch.clientAccess,
  });
};

import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../state/atom-registry";
import { environmentSession } from "../state/session";
import { revokeFactorySessions } from "./factorySignIn";

/**
 * The way out of the Factory screen's sign-in: when the user removes an environment, its
 * Factory browser sessions are revoked on the server before the bearer goes, so the cookie the
 * WebView keeps no longer opens anything. Runs in the background and never blocks the removal;
 * an unreachable server leaves the session to be revoked from its Connections settings.
 */
export function forgetFactorySession(environmentId: EnvironmentId): void {
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  if (prepared === null || prepared.httpAuthorization?._tag !== "Bearer") return;
  void revokeFactorySessions(
    { httpBaseUrl: prepared.httpBaseUrl, bearerToken: prepared.httpAuthorization.token },
    fetch,
  );
}

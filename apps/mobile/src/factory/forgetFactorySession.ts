import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import * as Dialog from "../components/ui/Dialog";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentSession } from "../state/session";
import {
  FACTORY_SESSION_LABEL,
  factorySessionsMayRemain,
  revokeFactorySessions,
} from "./factorySignIn";

/**
 * The way out of the Factory screen's sign-in: when the user removes an environment, its
 * Factory browser sessions are revoked on the server before the bearer goes, so the cookie the
 * WebView keeps no longer opens anything. The removal never waits for this. When the server
 * cannot be asked, or a session stays, the user is told where to revoke it by hand.
 */
export async function forgetFactorySession(environmentId: EnvironmentId): Promise<void> {
  const prepared = Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
  const outcome =
    prepared === null || prepared.httpAuthorization?._tag !== "Bearer"
      ? null
      : await revokeFactorySessions(
          { httpBaseUrl: prepared.httpBaseUrl, bearerToken: prepared.httpAuthorization.token },
          fetch,
        );
  if (factorySessionsMayRemain(outcome)) {
    Dialog.alert(
      "Factory sign-in not revoked",
      `If you opened the Factory screen for this environment, its sign-in is still valid on the server. Revoke "${FACTORY_SESSION_LABEL}" under the server's Connections settings.`,
    );
  }
}

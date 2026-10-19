import { isRelayManagedConnection, type SavedRemoteConnection } from "../lib/connection";

export const FACTORY_RELAY_ONLY_MESSAGE =
  "Factory pages need a direct connection. Pair this phone with the server over the tailnet.";

export const FACTORY_NO_ENVIRONMENT_MESSAGE = "Add an environment in Settings to open Factory.";

export type FactoryEnvironmentChoice =
  | { readonly kind: "none" }
  | { readonly kind: "relay-only" }
  | { readonly kind: "one"; readonly connection: SavedRemoteConnection }
  | { readonly kind: "several"; readonly connections: ReadonlyArray<SavedRemoteConnection> };

/** Relay (DPoP, T3 Connect) connections cannot sign a WebView in, so only direct ones count. */
export function factoryEnvironmentChoice(
  connections: ReadonlyArray<SavedRemoteConnection>,
): FactoryEnvironmentChoice {
  if (connections.length === 0) return { kind: "none" };
  const direct = connections
    .filter((connection) => !isRelayManagedConnection(connection))
    .toSorted((a, b) => a.environmentLabel.localeCompare(b.environmentLabel));
  if (direct.length === 0) return { kind: "relay-only" };
  if (direct.length === 1) return { kind: "one", connection: direct[0]! };
  return { kind: "several", connections: direct };
}

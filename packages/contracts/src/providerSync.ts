import * as Schema from "effect/Schema";

/**
 * Client-orchestrated provider sync never receives plaintext secrets. Config
 * fields that were stored separately on the host arrive as this marker so a
 * later write can keep them without round-tripping the value. Shared with the
 * server settings secret mapper.
 */
export const SECRET_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

/** Config keys that belong to one machine's filesystem or local process. */
export const PROVIDER_INSTANCE_HOST_LOCAL_CONFIG_KEYS = [
  "binaryPath",
  "homePath",
  "shadowHomePath",
  "serverUrl",
] as const;

export const ProviderSyncRemovalScope = Schema.Literals(["all-devices", "this-device"]);
export type ProviderSyncRemovalScope = typeof ProviderSyncRemovalScope.Type;

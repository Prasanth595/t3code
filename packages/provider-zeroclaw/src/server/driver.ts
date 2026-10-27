// Driver — implemented in Phase 6.
import { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { ZeroClawSettings } from "../settings.ts";

export type ZeroClawDriverEnv = never;

export const ZeroClawDriver: ProviderDriver<ZeroClawSettings, ZeroClawDriverEnv> = {
  driverKind: ProviderDriverKind.make("zeroclaw"),
  metadata: { displayName: "ZeroClaw", supportsMultipleInstances: true },
  configSchema: ZeroClawSettings,
  defaultConfig: () => ({}) as ZeroClawSettings,
  create: (() => {
    throw new Error("Not implemented");
  }) as never,
};

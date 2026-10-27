// Adapter — implemented in Phase 5.
import { ProviderDriverKind } from "@t3tools/contracts";
import type {
  ProviderAdapterDriver,
  ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { ZeroClawSettings } from "../settings.ts";

export type ZeroClawAdapterV2DriverEnv = never;

export const ZeroClawAdapterV2Driver: ProviderAdapterDriver<
  ZeroClawSettings,
  ZeroClawAdapterV2DriverEnv
> = {
  driverKind: ProviderDriverKind.make("zeroclaw"),
  configSchema: ZeroClawSettings,
  defaultConfig: () => ({}) as ZeroClawSettings,
  create: (() => {
    throw new Error("Not implemented");
  }) as (input: ProviderAdapterDriverCreateInput<ZeroClawSettings>) => never,
};

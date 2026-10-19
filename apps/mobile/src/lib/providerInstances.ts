import type { ServerConfig, ServerProvider } from "@t3tools/contracts";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";

export type ProviderBadge = {
  readonly displayName: string;
  readonly accentColor?: string;
};

export function resolveProviderBadge(
  config: ServerConfig | null | undefined,
  provider: ServerProvider,
): ProviderBadge | undefined {
  const badgeEntry = (candidate: ServerProvider) => {
    const settings = config?.settings?.providerInstances[candidate.instanceId]?.config;
    const agentId =
      candidate.driver === "acpRegistry" &&
      typeof settings === "object" &&
      settings !== null &&
      !("source" in settings && settings.source === "local") &&
      "agentId" in settings &&
      typeof settings.agentId === "string"
        ? settings.agentId.trim()
        : undefined;
    return {
      driverKind: candidate.driver,
      acpRegistryAgentId: agentId || undefined,
    };
  };
  const accentColor = normalizeProviderAccentColor(provider.accentColor);
  if (
    !shouldShowInstanceBadge(
      { ...badgeEntry(provider), accentColor },
      (config?.providers ?? []).map(badgeEntry),
    )
  ) {
    return undefined;
  }
  return {
    displayName: resolveProviderInstanceDisplayName(provider),
    ...(accentColor ? { accentColor } : {}),
  };
}

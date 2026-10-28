import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

export const voiceCapableProviders = (providers: ReadonlyArray<ServerProvider> | null) =>
  providers?.filter((provider) => provider.enabled && provider.supportsRealtimeVoice) ?? [];

/** The account the user picked, else the one the thread already runs on, else the first. */
export const pickVoiceProvider = (
  candidates: ReadonlyArray<ServerProvider>,
  chosen: ProviderInstanceId | undefined,
  preferred: ProviderInstanceId | undefined,
) =>
  candidates.find((provider) => provider.instanceId === chosen) ??
  candidates.find((provider) => provider.instanceId === preferred) ??
  candidates[0];

/** Accounts that can run a chat right now, with the models the composer's picker lists as current. */
export const chatModelProviders = (providers: ReadonlyArray<ServerProvider> | null) =>
  (providers ?? [])
    .filter((provider) => provider.enabled && provider.status === "ready" && provider.installed)
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => !model.isLegacy),
    }))
    .filter((provider) => provider.models.length > 0);

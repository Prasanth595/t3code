import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";

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

/** Voice-capable accounts' drivers that can run a chat right now, with the models the composer's picker lists as current. */
export const chatModelProviders = (
  providers: ReadonlyArray<ServerProvider> | null,
  voiceCandidates: ReadonlyArray<ServerProvider>,
) =>
  (providers ?? [])
    .filter((provider) => voiceCandidates.some((candidate) => candidate.driver === provider.driver))
    .filter((provider) => provider.enabled && provider.status === "ready" && provider.installed)
    .map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => !model.isLegacy),
    }))
    .filter((provider) => provider.models.length > 0);

/** The effort choices of the picked model, if it has any. */
export const effortDescriptor = (
  modelProviders: ReadonlyArray<ServerProvider>,
  selection: ModelSelection | undefined,
) => {
  const model = modelProviders
    .find((provider) => provider.instanceId === selection?.instanceId)
    ?.models.find((candidate) => candidate.slug === selection?.model);
  return getProviderOptionDescriptors({
    caps: model?.capabilities ?? {},
    selections: selection?.options,
  }).find((descriptor) => descriptor.id === "effort" && descriptor.type === "select");
};

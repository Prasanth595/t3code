import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderInstanceId,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";

import { mergeEnvironmentSettings, useMergedSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { settingKeyRepresentative, targetStoresSettingKeys } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";

/** Catalog and settings from one selected environment that can store `key`, so they agree. */
export function useScopedModelProviders(key: keyof ServerSettings) {
  const { target, targets } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const source = settingKeyRepresentative(target, targets, key);
  const settings = useMergedSettings(source?.settings ?? DEFAULT_SERVER_SETTINGS);
  return {
    environmentId: source?.environmentId ?? null,
    projectId: source?.projectId ?? null,
    settings,
    providers:
      (source ? providersByEnvironment.get(source.environmentId) : undefined) ??
      EMPTY_SERVER_PROVIDERS,
  };
}

export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
  key: keyof ServerSettings,
) {
  const { targets } = useSettingsScope();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  return (instanceId: ProviderInstanceId, model: string): string | null => {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    for (const candidate of targets) {
      if (!targetStoresSettingKeys(candidate, [key])) continue;
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      const providers = providersByEnvironment.get(candidate.environmentId);
      if (!environment?.serverConfig || !providers) continue;
      const entry = applyProviderInstanceSettings(
        deriveProviderInstanceEntries(providers),
        candidate.settings,
        candidate.projectId,
      ).find((option) => option.instanceId === instanceId);
      const options = getCustomModelOptionsByInstance(
        mergeEnvironmentSettings(candidate.settings, settings),
        providers,
      ).get(instanceId);
      if (
        !entry?.enabled ||
        !entry.isAvailable ||
        entry.driverKind !== sourceEntry?.driverKind ||
        !options?.some((option) => option.slug === model && !option.isUnavailable)
      ) {
        return `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
      }
    }
    return null;
  };
}

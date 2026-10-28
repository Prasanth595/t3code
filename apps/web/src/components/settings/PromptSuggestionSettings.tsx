import { resolvePromptSuggestionModelSelection } from "@t3tools/shared/serverSettings";
import { createModelSelection } from "@t3tools/shared/model";

import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function PromptSuggestionSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const projectId = target?.projectId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const mixedEnabled = useScopedSettingsMixed(["promptSuggestionsEnabled"]);
  const mixedModel = useScopedSettingsMixed(["promptSuggestionModelSelection"]);
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const instanceEntries = providerInstanceEntriesFor(textGenerationProviders, settings, projectId);
  const hasTextGenerationProvider = instanceEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const selection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolvePromptSuggestionModelSelection(
        settings,
        textGenerationProviders,
        projectId,
      ),
    },
    textGenerationProviders,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const enabled = settings.promptSuggestionsEnabled || mixedEnabled;

  return (
    <SettingsSection id="prompt-suggestions-section" title="Prompt suggestions">
      <SettingsRow
        serverScoped
        settingKeys={["promptSuggestionsEnabled"]}
        mixed={mixedEnabled}
        {...searchableSetting("prompt-suggestions")}
        description="After a turn finishes, suggests your next message in the empty composer. Press Tab or → to insert it and keep editing. Each suggestion is one short model request."
        control={
          <Switch
            mixed={mixedEnabled}
            checked={mixedEnabled ? false : settings.promptSuggestionsEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ promptSuggestionsEnabled: Boolean(checked) })
            }
            aria-label="Prompt suggestions"
          />
        }
      />
      {enabled ? (
        <SettingsRow
          serverScoped
          settingKeys={["promptSuggestionModelSelection"]}
          mixed={mixedModel}
          {...searchableSetting("prompt-suggestion-model")}
          description="Model that reads the recent conversation to suggest your next message. A fast model keeps suggestions quick. Reset to use the text generation model."
          resetAction={
            hasServerTargets && (mixedModel || settings.promptSuggestionModelSelection !== null) ? (
              <SettingResetButton
                label="prompt suggestion model"
                onClick={() => updateSettings({ promptSuggestionModelSelection: null })}
              />
            ) : null
          }
          control={
            !hasServerTargets ? (
              <span className="text-sm text-muted-foreground">
                Connect an environment to choose its prompt suggestion model.
              </span>
            ) : !hasTextGenerationProvider ? (
              <span className="text-sm text-muted-foreground">
                No text generation providers available.
              </span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  triggerAriaLabel="Prompt suggestion model"
                  {...(mixedModel ? { triggerLabel: "Mixed" } : {})}
                  getModelDisabledReason={modelDisabledReason}
                  onInstanceModelChange={(instanceId, model) => {
                    const reason = modelDisabledReason(instanceId, model);
                    if (reason) {
                      toastManager.add({
                        type: "error",
                        title: "Prompt suggestion model not saved",
                        description: reason,
                      });
                      return;
                    }
                    updateSettings({
                      promptSuggestionModelSelection: createModelSelection(instanceId, model),
                    });
                  }}
                />
                {instanceEntry && !mixedModel ? (
                  <TraitsPicker
                    provider={instanceEntry.driverKind}
                    models={instanceEntry.models}
                    model={selection.model}
                    modelOptions={selection.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={
                      settings.planModeEnabled || selectsPlanAgent(selection.options)
                    }
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    onModelOptionsChange={(options) =>
                      updateSettings({
                        promptSuggestionModelSelection: createModelSelection(
                          selection.instanceId,
                          selection.model,
                          options,
                        ),
                      })
                    }
                  />
                ) : null}
              </div>
            )
          }
        />
      ) : null}
    </SettingsSection>
  );
}

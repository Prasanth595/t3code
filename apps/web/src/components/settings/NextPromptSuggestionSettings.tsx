import { useRef } from "react";

import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function NextPromptSuggestionSettings() {
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const mixedEnabled = useScopedSettingsMixed(["nextPromptSuggestionsEnabled"]);
  const mixedInstructions = useScopedSettingsMixed(["nextPromptInstructions"]);

  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={["nextPromptSuggestionsEnabled"]}
        mixed={mixedEnabled}
        {...searchableSetting("next-prompt-suggestions")}
        description="After the agent replies, suggest your next message in the empty composer. Press Tab to use it; it is never sent for you. Each suggestion is one extra request to the text generation model."
        control={
          <Switch
            mixed={mixedEnabled}
            checked={mixedEnabled ? false : settings.nextPromptSuggestionsEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ nextPromptSuggestionsEnabled: Boolean(checked) })
            }
            aria-label="Next prompt suggestions"
          />
        }
      />
      {settings.nextPromptSuggestionsEnabled || mixedEnabled ? (
        <SettingsRow
          serverScoped
          settingKeys={["nextPromptInstructions"]}
          {...searchableSetting("next-prompt-instructions")}
          description="Appended to the prompt that predicts your next message."
          resetAction={
            mixedInstructions || settings.nextPromptInstructions !== "" ? (
              <SettingResetButton
                label="next prompt instructions"
                onClick={() => updateSettings({ nextPromptInstructions: "" })}
              />
            ) : null
          }
        >
          <div className="mt-3 max-w-2xl pb-3.5">
            <Textarea
              key={`${scopeKey}:${mixedInstructions}:${settings.nextPromptInstructions}`}
              aria-label="Next prompt instructions"
              onChange={() => {
                edited.current = true;
              }}
              rows={4}
              defaultValue={mixedInstructions ? "" : settings.nextPromptInstructions}
              placeholder={
                mixedInstructions
                  ? "Mixed. Enter instructions to apply to all selected targets."
                  : "Write suggestions as short commands. Prefer asking for tests before merging."
              }
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (
                  edited.current &&
                  (mixedInstructions || value !== settings.nextPromptInstructions)
                )
                  updateSettings({ nextPromptInstructions: value });
                edited.current = false;
              }}
            />
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}

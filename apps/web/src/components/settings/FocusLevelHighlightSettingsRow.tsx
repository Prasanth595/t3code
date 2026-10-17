import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectEnabled = (settings: ClientSettings) => settings.focusLevelHighlight;

/** Fork: `focusLevelHighlight`, the outline fade on the area that takes keyboard focus. */
export function FocusLevelHighlightSettingsRow() {
  const enabled = useClientSettings(selectEnabled);
  const updateSettings = useUpdateClientSettings();
  return (
    <SettingsRow
      {...searchableSetting("focus-level-highlight")}
      description="Briefly outline the composer, timeline, sidebar or right panel when focus moves to it."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.focusLevelHighlight ? (
          <SettingResetButton
            label="focus highlight"
            onClick={() =>
              void updateSettings({
                focusLevelHighlight: DEFAULT_CLIENT_SETTINGS.focusLevelHighlight,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateSettings({ focusLevelHighlight: Boolean(checked) })
          }
          aria-label="Focus highlight"
        />
      }
    />
  );
}

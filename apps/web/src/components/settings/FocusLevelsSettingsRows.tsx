import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectLevels = (settings: ClientSettings) => settings.keyboardFocusLevels;
const selectHighlight = (settings: ClientSettings) => settings.focusLevelHighlight;

/** Fork: `keyboardFocusLevels`, Escape and arrow keys move focus between areas of the screen. */
export function KeyboardFocusLevelsSettingsRow() {
  const enabled = useClientSettings(selectLevels);
  const updateSettings = useUpdateClientSettings();
  return (
    <SettingsRow
      {...searchableSetting("keyboard-focus-levels")}
      description="Escape moves focus from the composer to the timeline, then to the sidebar. Arrow keys move a cursor there to open threads, switch groups and cite parts of messages."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.keyboardFocusLevels ? (
          <SettingResetButton
            label="keyboard focus levels"
            onClick={() =>
              void updateSettings({
                keyboardFocusLevels: DEFAULT_CLIENT_SETTINGS.keyboardFocusLevels,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateSettings({ keyboardFocusLevels: Boolean(checked) })
          }
          aria-label="Keyboard focus levels"
        />
      }
    />
  );
}

/** Fork: `focusLevelHighlight`, the outline fade on the area that takes keyboard focus. */
export function FocusLevelHighlightSettingsRow() {
  const enabled = useClientSettings(selectHighlight);
  const updateSettings = useUpdateClientSettings();
  return (
    <SettingsRow
      {...searchableSetting("focus-level-highlight")}
      description="Briefly outline the composer, timeline, sidebar or right panel when a key moves focus to it."
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

const selectTooltipShortcuts = (settings: ClientSettings) => settings.tooltipShortcuts;

/** Fork: `tooltipShortcuts`, control tooltips name the keyboard shortcut of the control. */
export function TooltipShortcutsSettingsRow() {
  const enabled = useClientSettings(selectTooltipShortcuts);
  const updateSettings = useUpdateClientSettings();
  return (
    <SettingsRow
      {...searchableSetting("tooltip-shortcuts")}
      description="Show the keyboard shortcut of a control in its tooltip, such as the stash, the runtime mode or the approval buttons."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.tooltipShortcuts ? (
          <SettingResetButton
            label="shortcuts in tooltips"
            onClick={() =>
              void updateSettings({ tooltipShortcuts: DEFAULT_CLIENT_SETTINGS.tooltipShortcuts })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => void updateSettings({ tooltipShortcuts: Boolean(checked) })}
          aria-label="Shortcuts in tooltips"
        />
      }
    />
  );
}

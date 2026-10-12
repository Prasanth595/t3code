import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { isElectronAccelerator } from "@t3tools/shared/electronAccelerator";
import { useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectAppToggleShortcuts = (settings: ClientSettings) => settings.appToggleShortcuts;

/** Splits "F17, Alt+Space" into shortcuts, without blanks or repeats. */
const parseShortcuts = (text: string) => [
  ...new Set(
    text
      .split(",")
      .map((shortcut) => shortcut.trim())
      .filter((shortcut) => shortcut.length > 0),
  ),
];

/** Fork, desktop only: `appToggleShortcuts`, global keys that show and hide the app. */
export function AppToggleShortcutsSettingsRow() {
  const shortcuts = useClientSettings(selectAppToggleShortcuts);
  const updateSettings = useUpdateClientSettings();
  const saved = shortcuts.join(", ");
  // The field keeps what the user typed until it saves, so a rejected key stays visible.
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<readonly string[]>([]);

  const save = () => {
    if (draft === null) return;
    const next = parseShortcuts(draft);
    const rejected = next.filter((shortcut) => !isElectronAccelerator(shortcut));
    setInvalid(rejected);
    if (rejected.length > 0) return;
    setDraft(null);
    void updateSettings({ appToggleShortcuts: next });
  };

  return (
    <SettingsRow
      {...searchableSetting("app-toggle-shortcuts")}
      description="Global keys that bring the app to the front, or hide it when it is in front. Separate keys with commas, for example F17, Alt+Space."
      status={
        invalid.length > 0 ? (
          <span className="text-destructive-foreground">
            Not a key the desktop app can register: {invalid.join(", ")}. Keys such as § have no
            name in Electron; map them to a function key, for example with Karabiner.
          </span>
        ) : null
      }
      resetAction={
        shortcuts.length > 0 ? (
          <SettingResetButton
            label="app toggle shortcuts"
            onClick={() => {
              setDraft(null);
              setInvalid([]);
              void updateSettings({
                appToggleShortcuts: DEFAULT_CLIENT_SETTINGS.appToggleShortcuts,
              });
            }}
          />
        ) : null
      }
      control={
        <Input
          className="w-44"
          value={draft ?? saved}
          placeholder="F17"
          aria-label="App toggle shortcuts"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
        />
      }
    />
  );
}

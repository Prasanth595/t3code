import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: `keybindingSync`, the keybindings of this machine sync through the machine map. */
export function KeybindingSyncSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["keybindingSync"]);

  return (
    <SettingsRow
      {...searchableSetting("keybinding-sync")}
      serverScoped
      settingKeys={["keybindingSync"]}
      description="The machine map syncs keybindings.json like other settings. A change for all environments becomes the shared value; a change for one environment stays on that machine."
      resetAction={
        mixed || settings.keybindingSync !== DEFAULT_SERVER_SETTINGS.keybindingSync ? (
          <SettingResetButton
            label="keybinding sync"
            onClick={() =>
              updateSettings({ keybindingSync: DEFAULT_SERVER_SETTINGS.keybindingSync })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["keybindingSync"]}
          checked={settings.keybindingSync}
          onCheckedChange={(checked) => updateSettings({ keybindingSync: Boolean(checked) })}
          aria-label="Sync keybindings through the machine map"
        />
      }
    />
  );
}

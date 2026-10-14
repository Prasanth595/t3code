import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectInstalledAppEnabled = (settings: ClientSettings) => settings.installedAppEnabled;

/** Fork setting: the service worker of the installed web app. The desktop app does not need it. */
export function InstalledAppSettingsRow() {
  const enabled = useClientSettings(selectInstalledAppEnabled);
  const updateSettings = useUpdateClientSettings();
  if (isElectron) return null;

  return (
    <SettingsRow
      {...searchableSetting("installed-app")}
      description="For T3 Code installed from the browser (Install app, or Add to Home Screen on iPhone). Shows an offline page when this server does not answer, shows notifications on Android and iPhone, and counts them on the app icon. Applies to this browser."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.installedAppEnabled ? (
          <SettingResetButton
            label="installed app"
            onClick={() =>
              void updateSettings({
                installedAppEnabled: DEFAULT_CLIENT_SETTINGS.installedAppEnabled,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => void updateSettings({ installedAppEnabled: checked })}
          aria-label="Installed app"
        />
      }
    />
  );
}

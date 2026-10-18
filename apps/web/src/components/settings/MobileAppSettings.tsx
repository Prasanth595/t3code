import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: server settings that only the mobile app reads. */
export function MobileAppSettingsSection() {
  return (
    <SettingsSection id="mobile-app" title="Mobile app">
      <MobilePublishedThemesSettingsRow />
    </SettingsSection>
  );
}

export function MobilePublishedThemesSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mobilePublishedThemes"]);
  const fallback = DEFAULT_SERVER_SETTINGS.mobilePublishedThemes;
  return (
    <SettingsRow
      {...searchableSetting("mobile-published-themes")}
      serverScoped
      settingKeys={["mobilePublishedThemes"]}
      description="The mobile app offers the themes that this server publishes, with their fonts, shape and canvas pattern, and takes the default theme."
      resetAction={
        mixed || settings.mobilePublishedThemes !== fallback ? (
          <SettingResetButton
            label="published themes on mobile"
            onClick={() => updateSettings({ mobilePublishedThemes: fallback })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["mobilePublishedThemes"]}
          checked={settings.mobilePublishedThemes}
          onCheckedChange={(checked) => updateSettings({ mobilePublishedThemes: Boolean(checked) })}
          aria-label="Published themes on mobile"
        />
      }
    />
  );
}

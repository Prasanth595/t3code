import {
  DEFAULT_SERVER_SETTINGS,
  MobileNewThreadProject,
  type MobileNewThreadProject as MobileNewThreadProjectValue,
} from "@t3tools/contracts";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const NEW_THREAD_LABELS = {
  picker: "Choose a project",
  last: "Last project",
  none: "No project",
} satisfies Record<MobileNewThreadProjectValue, string>;

/** Fork: server settings that only the mobile app reads. */
export function MobileAppSettingsSection() {
  return (
    <SettingsSection id="mobile-app" title="Mobile app">
      <MobilePublishedThemesSettingsRow />
      <MobileNewThreadProjectSettingsRow />
      <MobileComposerCameraSettingsRow />
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

export function MobileComposerCameraSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mobileComposerCamera"]);
  const fallback = DEFAULT_SERVER_SETTINGS.mobileComposerCamera;
  return (
    <SettingsRow
      {...searchableSetting("mobile-composer-camera")}
      serverScoped
      settingKeys={["mobileComposerCamera"]}
      description="The plus button of the mobile composer offers Take Photo, next to the photo library and files."
      resetAction={
        mixed || settings.mobileComposerCamera !== fallback ? (
          <SettingResetButton
            label="camera on mobile"
            onClick={() => updateSettings({ mobileComposerCamera: fallback })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["mobileComposerCamera"]}
          checked={settings.mobileComposerCamera}
          onCheckedChange={(checked) => updateSettings({ mobileComposerCamera: Boolean(checked) })}
          aria-label="Camera on mobile"
        />
      }
    />
  );
}

export function MobileNewThreadProjectSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["mobileNewThreadProject"]);
  const fallback = DEFAULT_SERVER_SETTINGS.mobileNewThreadProject;
  return (
    <SettingsRow
      {...searchableSetting("mobile-new-thread-project")}
      serverScoped
      settingKeys={["mobileNewThreadProject"]}
      description="What New thread opens in the mobile app: the project list, a draft in the project of the last new thread on the phone, or a draft without a project."
      resetAction={
        mixed || settings.mobileNewThreadProject !== fallback ? (
          <SettingResetButton
            label="new thread on mobile"
            onClick={() => updateSettings({ mobileNewThreadProject: fallback })}
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : settings.mobileNewThreadProject}
          onValueChange={(value) => {
            if (MobileNewThreadProject.literals.includes(value as MobileNewThreadProjectValue)) {
              updateSettings({ mobileNewThreadProject: value as MobileNewThreadProjectValue });
            }
          }}
        >
          <SelectTrigger size="sm" aria-label="New thread on mobile">
            <SelectValue>
              {(value: MobileNewThreadProjectValue | null) =>
                value === null ? "Mixed" : NEW_THREAD_LABELS[value]
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {MobileNewThreadProject.literals.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {NEW_THREAD_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

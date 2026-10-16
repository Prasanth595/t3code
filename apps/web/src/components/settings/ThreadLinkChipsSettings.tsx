import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: `threadLinkChips`, the attached-thread chip for every thread link. */
export function ThreadLinkChipsSettingsSection() {
  return (
    <SettingsSection id="thread-links" title="Thread links">
      <ThreadLinkChipsSettingsRow />
    </SettingsSection>
  );
}

export function ThreadLinkChipsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["threadLinkChips"]);

  return (
    <SettingsRow
      {...searchableSetting("thread-link-chips")}
      serverScoped
      settingKeys={["threadLinkChips"]}
      description="Thread links in chat look like an attached thread. A web link to a thread on this machine or a connected machine opens the thread here, not in a browser. Applies on desktop, web and the mobile app."
      resetAction={
        mixed || settings.threadLinkChips !== DEFAULT_SERVER_SETTINGS.threadLinkChips ? (
          <SettingResetButton
            label="thread link chips"
            onClick={() =>
              updateSettings({ threadLinkChips: DEFAULT_SERVER_SETTINGS.threadLinkChips })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["threadLinkChips"]}
          checked={settings.threadLinkChips}
          onCheckedChange={(checked) => updateSettings({ threadLinkChips: Boolean(checked) })}
          aria-label="Thread link chips"
        />
      }
    />
  );
}

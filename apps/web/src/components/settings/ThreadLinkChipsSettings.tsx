import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: the thread link settings, `threadLinkChips` and `threadLinksOpenDesktopApp`. */
export function ThreadLinkChipsSettingsSection() {
  return (
    <SettingsSection id="thread-links" title="Thread links">
      <ThreadLinkChipsSettingsRow />
      <ThreadLinksOpenDesktopAppSettingsRow />
    </SettingsSection>
  );
}

export function ThreadLinkChipsSettingsRow() {
  return (
    <ThreadLinkSwitchRow
      settingKey="threadLinkChips"
      searchId="thread-link-chips"
      label="Thread link chips"
      description="Every thread link in chat looks like an attached thread: thread links, app links, web addresses of a thread on this machine or a connected machine, and the thread markers that agents copy. A click opens the thread here, not in a browser. Applies on desktop, web and the mobile app."
    />
  );
}

export function ThreadLinksOpenDesktopAppSettingsRow() {
  return (
    <ThreadLinkSwitchRow
      settingKey="threadLinksOpenDesktopApp"
      searchId="thread-links-open-desktop-app"
      label="Thread addresses open the desktop app"
      description="A thread address opened from another app, such as Slack or GitHub, in a new browser tab opens the thread in the desktop app at once. The tab offers to continue in the browser."
    />
  );
}

function ThreadLinkSwitchRow(props: {
  readonly settingKey: "threadLinkChips" | "threadLinksOpenDesktopApp";
  readonly searchId: "thread-link-chips" | "thread-links-open-desktop-app";
  readonly label: string;
  readonly description: string;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed([props.settingKey]);
  const fallback = DEFAULT_SERVER_SETTINGS[props.settingKey];

  return (
    <SettingsRow
      {...searchableSetting(props.searchId)}
      serverScoped
      settingKeys={[props.settingKey]}
      description={props.description}
      resetAction={
        mixed || settings[props.settingKey] !== fallback ? (
          <SettingResetButton
            label={props.label.toLowerCase()}
            onClick={() => updateSettings({ [props.settingKey]: fallback })}
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={[props.settingKey]}
          checked={settings[props.settingKey]}
          onCheckedChange={(checked) => updateSettings({ [props.settingKey]: Boolean(checked) })}
          aria-label={props.label}
        />
      }
    />
  );
}

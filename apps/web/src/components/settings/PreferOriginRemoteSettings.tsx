import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: `preferOriginRemote`, which repository a fork checkout's pull requests come from. */
export function PreferOriginRemoteSettingsSection() {
  return (
    <SettingsSection id="fork-checkouts" title="Fork checkouts">
      <PreferOriginRemoteSettingsRow />
    </SettingsSection>
  );
}

export function PreferOriginRemoteSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["preferOriginRemote"]);

  return (
    <SettingsRow
      {...searchableSetting("prefer-origin-remote")}
      serverScoped
      settingKeys={["preferOriginRemote"]}
      description="A checkout with both an origin and an upstream remote counts as its origin repository. Pull requests then come from your fork, not from upstream. To create pull requests on the fork too, run gh repo set-default in the checkout."
      resetAction={
        mixed || settings.preferOriginRemote !== DEFAULT_SERVER_SETTINGS.preferOriginRemote ? (
          <SettingResetButton
            label="pull requests from origin"
            onClick={() =>
              updateSettings({
                preferOriginRemote: DEFAULT_SERVER_SETTINGS.preferOriginRemote,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["preferOriginRemote"]}
          checked={settings.preferOriginRemote}
          onCheckedChange={(checked) => updateSettings({ preferOriginRemote: Boolean(checked) })}
          aria-label="Pull requests from origin"
        />
      }
    />
  );
}

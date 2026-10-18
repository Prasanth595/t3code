import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { ScopedSwitch } from "./ScopedSwitch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: `previewLocalServerGroups`, the groups of the browser "Local servers" list. */
export function PreviewLocalServerGroupsSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["previewLocalServerGroups"]);

  return (
    <SettingsRow
      {...searchableSetting("preview-local-server-groups")}
      serverScoped
      settingKeys={["previewLocalServerGroups"]}
      description="The Local servers list of a new browser tab also shows servers that no T3 terminal started: first those in the thread's worktree, then those in its project, then all others. Servers outside every project are not checked; open them by hand."
      resetAction={
        mixed ||
        settings.previewLocalServerGroups !== DEFAULT_SERVER_SETTINGS.previewLocalServerGroups ? (
          <SettingResetButton
            label="all local servers"
            onClick={() =>
              updateSettings({
                previewLocalServerGroups: DEFAULT_SERVER_SETTINGS.previewLocalServerGroups,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["previewLocalServerGroups"]}
          checked={settings.previewLocalServerGroups}
          onCheckedChange={(checked) =>
            updateSettings({ previewLocalServerGroups: Boolean(checked) })
          }
          aria-label="All local servers in the browser"
        />
      }
    />
  );
}

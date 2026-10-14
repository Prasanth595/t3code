import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectEnabled = (settings: ClientSettings) => settings.sidebarGroupsEnabled;
const selectSingleThreadOpens = (settings: ClientSettings) =>
  settings.sidebarGroupSingleThreadOpens;

/** Fork: `sidebarGroupsEnabled` and `sidebarGroupSingleThreadOpens`, thread groups as tabs. */
export function SidebarGroupsSettingsRow() {
  const enabled = useClientSettings(selectEnabled);
  const singleThreadOpens = useClientSettings(selectSingleThreadOpens);
  const updateSettings = useUpdateClientSettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("sidebar-groups")}
        description="Group threads in tabs above the sidebar list. Drag a thread onto a tab to move it, or onto the empty end of the tab bar to make a new group. Rules put matching threads in a group."
        resetAction={
          enabled !== DEFAULT_CLIENT_SETTINGS.sidebarGroupsEnabled ? (
            <SettingResetButton
              label="sidebar groups"
              onClick={() =>
                void updateSettings({
                  sidebarGroupsEnabled: DEFAULT_CLIENT_SETTINGS.sidebarGroupsEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              void updateSettings({ sidebarGroupsEnabled: Boolean(checked) })
            }
            aria-label="Sidebar groups"
          />
        }
      />
      {enabled ? (
        <SettingsRow
          {...searchableSetting("sidebar-group-single-thread")}
          description="A tab with one thread shows that thread, and a click opens it."
          resetAction={
            singleThreadOpens !== DEFAULT_CLIENT_SETTINGS.sidebarGroupSingleThreadOpens ? (
              <SettingResetButton
                label="single-thread tabs"
                onClick={() =>
                  void updateSettings({
                    sidebarGroupSingleThreadOpens:
                      DEFAULT_CLIENT_SETTINGS.sidebarGroupSingleThreadOpens,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={singleThreadOpens}
              onCheckedChange={(checked) =>
                void updateSettings({ sidebarGroupSingleThreadOpens: Boolean(checked) })
              }
              aria-label="Single-thread tabs open the thread"
            />
          }
        />
      ) : null}
    </>
  );
}

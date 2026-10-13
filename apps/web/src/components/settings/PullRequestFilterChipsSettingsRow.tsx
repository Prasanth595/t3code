import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectEnabled = (settings: ClientSettings) => settings.pullRequestFilterChips;

/** Fork: `pullRequestFilterChips`, the active filters as chips above the pull request list. */
export function PullRequestFilterChipsSettingsRow() {
  const enabled = useClientSettings(selectEnabled);
  const updateSettings = useUpdateClientSettings();
  return (
    <SettingsRow
      {...searchableSetting("pull-request-filter-chips")}
      description="Show the active filters above the pull request list. Click is or is not to flip a filter, or remove it. An empty list names the filters that emptied it."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.pullRequestFilterChips ? (
          <SettingResetButton
            label="pull request filter chips"
            onClick={() =>
              void updateSettings({
                pullRequestFilterChips: DEFAULT_CLIENT_SETTINGS.pullRequestFilterChips,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateSettings({ pullRequestFilterChips: Boolean(checked) })
          }
          aria-label="Pull request filter chips"
        />
      }
    />
  );
}

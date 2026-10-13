import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectEnabled = (settings: ClientSettings) => settings.repositoryOwnerFilters;

/** Fork: `repositoryOwnerFilters`, owner filters on the pull request page and sidebar, usage by owner. */
export function RepositoryOwnerFiltersSettingsRow() {
  const enabled = useClientSettings(selectEnabled);
  const updateSettings = useUpdateClientSettings();
  return (
    <SettingsRow
      {...searchableSetting("repository-owner-filters")}
      description="Filter pull requests and sidebar projects by the account or organization that owns their repository, and split usage by owner."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.repositoryOwnerFilters ? (
          <SettingResetButton
            label="repository owner filters"
            onClick={() =>
              void updateSettings({
                repositoryOwnerFilters: DEFAULT_CLIENT_SETTINGS.repositoryOwnerFilters,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateSettings({ repositoryOwnerFilters: Boolean(checked) })
          }
          aria-label="Repository owner filters"
        />
      }
    />
  );
}

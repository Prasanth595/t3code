import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { ForkChangelogDialog } from "../forkChangelog/ForkChangelogDialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectForkChangelogEnabled = (settings: ClientSettings) => settings.forkChangelogEnabled;

/** Fork setting: turns on the changelog, and opens it from the About section. */
export function ForkChangelogSettingsRow() {
  const enabled = useClientSettings(selectForkChangelogEnabled);
  const updateSettings = useUpdateClientSettings();
  const [open, setOpen] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("fork-changelog")}
      description="Browse fork releases and their fork and upstream changes, see what upstream has that the fork does not, and start Fork Sync. Opens from here and from the update button."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.forkChangelogEnabled ? (
          <SettingResetButton
            label="fork changelog"
            onClick={() =>
              void updateSettings({
                forkChangelogEnabled: DEFAULT_CLIENT_SETTINGS.forkChangelogEnabled,
              })
            }
          />
        ) : null
      }
      control={
        <div className="flex items-center gap-2">
          {enabled ? (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Open
            </Button>
          ) : null}
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              void updateSettings({ forkChangelogEnabled: Boolean(checked) })
            }
            aria-label="Fork changelog"
          />
          {enabled ? <ForkChangelogDialog open={open} onOpenChange={setOpen} /> : null}
        </div>
      }
    />
  );
}

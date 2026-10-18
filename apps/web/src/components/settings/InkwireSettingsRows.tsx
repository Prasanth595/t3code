import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const selectWhiteFrame = (settings: ClientSettings) => settings.inkwireWhiteFrame;

/** Fork: `inkwireWhiteFrame`, a chalk outline while an Inkwire theme is on. */
export function InkwireWhiteFrameSettingsRow() {
  const enabled = useClientSettings(selectWhiteFrame);
  const updateSettings = useUpdateClientSettings();
  return (
    <SettingsRow
      {...searchableSetting("inkwire-white-frame")}
      description="While an Inkwire theme is selected, draw a white chalk frame around the window and sketched controls. Static CSS only, so it does not affect scrolling."
      resetAction={
        enabled !== DEFAULT_CLIENT_SETTINGS.inkwireWhiteFrame ? (
          <SettingResetButton
            label="Inkwire white frame"
            onClick={() =>
              void updateSettings({
                inkwireWhiteFrame: DEFAULT_CLIENT_SETTINGS.inkwireWhiteFrame,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateSettings({ inkwireWhiteFrame: Boolean(checked) })
          }
          aria-label="Inkwire white frame"
        />
      }
    />
  );
}

import { useRef } from "react";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { Input } from "../ui/input";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function WorktreeBaseBranchSetting() {
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["newWorktreesBaseBranch"]);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["newWorktreesBaseBranch"]}
      {...searchableSetting("worktree-base-branch")}
      description="New worktrees start from this branch. Leave empty to use the repository default branch."
      resetAction={
        mixed ||
        settings.newWorktreesBaseBranch !== DEFAULT_SERVER_SETTINGS.newWorktreesBaseBranch ? (
          <SettingResetButton
            label="worktree base branch"
            onClick={() =>
              updateSettings({
                newWorktreesBaseBranch: DEFAULT_SERVER_SETTINGS.newWorktreesBaseBranch,
              })
            }
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${settings.newWorktreesBaseBranch}`}
          aria-label="Worktree base branch"
          autoCapitalize="none"
          spellCheck={false}
          onChange={() => {
            edited.current = true;
          }}
          placeholder={mixed ? "Mixed" : "Default branch"}
          defaultValue={mixed ? "" : settings.newWorktreesBaseBranch}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.newWorktreesBaseBranch))
              updateSettings({ newWorktreesBaseBranch: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}

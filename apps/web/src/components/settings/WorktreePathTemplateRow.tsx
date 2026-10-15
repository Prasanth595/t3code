import { validateWorktreePathTemplate } from "@t3tools/shared/worktreePathTemplate";
import { useRef, useState } from "react";

import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Fork: the `worktreePathTemplate` setting. See docs/fork.md. */
export function WorktreePathTemplateRow() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreePathTemplate"]);
  const edited = useRef(false);
  // The error belongs to the scope that it was typed at, so another scope does not show it.
  const [error, setError] = useState<{
    readonly scopeKey: string;
    readonly message: string;
  } | null>(null);
  if (
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.worktreePathTemplate !== true,
    )
  )
    return null;
  const scopeKey = targets.map((target) => target.environmentId).join(",");
  const shownError = error?.scopeKey === scopeKey ? error.message : null;

  return (
    <SettingsRow
      {...searchableSetting("storage-worktree-path-template")}
      description={
        shownError ??
        "Path for each new worktree, built from {worktrees}, {repoDir}, {repo}, {branch} and {branchLeaf}. Use {repoDir}/{branchLeaf} for a .bare container repository. Auto-named threads then name the branch from the first message. Leave empty to use the worktree location."
      }
      serverScoped
      settingKeys={["worktreePathTemplate"]}
      resetAction={
        mixed || settings.worktreePathTemplate !== "" ? (
          <SettingResetButton
            label="worktree path template"
            onClick={() => updateSettings({ worktreePathTemplate: "" })}
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${settings.worktreePathTemplate}`}
          aria-label="Worktree path template"
          aria-invalid={shownError !== null}
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? "Mixed" : "Off"}
          defaultValue={mixed ? "" : settings.worktreePathTemplate}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            const invalid = value === "" ? null : validateWorktreePathTemplate(value);
            setError(invalid === null ? null : { scopeKey, message: invalid });
            if (
              invalid === null &&
              edited.current &&
              (mixed || value !== settings.worktreePathTemplate)
            )
              updateSettings({ worktreePathTemplate: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}

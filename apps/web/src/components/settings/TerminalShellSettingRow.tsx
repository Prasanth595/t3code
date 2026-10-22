import type { TerminalShellSetting } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useEffect, useState } from "react";

import {
  buildCustomShell,
  CUSTOM_SHELL_SELECT_VALUE,
  formatShellArgs,
  isCustomShell,
  shellSettingLabel,
  shellSettingToSelectValue,
} from "../terminal/terminalShell.logic";
import { ShellOption } from "../terminal/NewTerminalShellMenu";
import { useTerminalShells } from "../terminal/useTerminalShells";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { DraftInput } from "../ui/draft-input";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * Shells are detected on the server, so the list comes from the selected
 * environment; with several environments selected it is the first one's.
 */
export function TerminalShellSettingRow() {
  const { scope, target, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["terminalShell"]);
  const { shells, load } = useTerminalShells(target?.environmentId ?? null);
  const [customRequested, setCustomRequested] = useState(false);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;
  const effective = target
    ? resolveProjectSettings(target.settings, null, null, null).settings.terminalShell
    : null;
  const selectValue = mixed ? null : shellSettingToSelectValue(effective);
  const showCustom = !mixed && (customRequested || isCustomShell(effective));
  const custom = isCustomShell(effective) ? effective : null;
  const selectedProfile =
    !mixed && typeof effective === "string" && effective !== "auto"
      ? shells?.find((shell) => shell.id === effective)
      : undefined;

  // The trigger needs the list to show a profile's label; other values fetch when the select opens.
  const needsList = !mixed && typeof effective === "string" && effective !== "auto";
  useEffect(() => {
    if (needsList) load();
  }, [needsList, load]);

  const save = (value: TerminalShellSetting | null) => updateSettings({ terminalShell: value });

  return (
    <SettingsRow
      serverScoped
      settingKeys={["terminalShell"]}
      mixed={mixed}
      {...searchableSetting("terminal-shell")}
      description={
        isProjectScope
          ? "Shell for new terminals in this project."
          : "Shell for new terminals. Projects and their t3.json can override it."
      }
      resetAction={
        !isProjectScope && settings.terminalShell !== null ? (
          <SettingResetButton
            label="default shell"
            onClick={() => {
              setCustomRequested(false);
              save(null);
            }}
          />
        ) : null
      }
      control={
        <Select
          value={selectValue}
          onOpenChange={(open) => {
            if (open) load();
          }}
          onValueChange={(value) => {
            if (value === CUSTOM_SHELL_SELECT_VALUE) {
              setCustomRequested(true);
              return;
            }
            setCustomRequested(false);
            if (value === "auto") save(isProjectScope ? "auto" : null);
            else if (value) save(value);
          }}
        >
          <SelectTrigger size="sm" aria-label="Default shell">
            <SelectValue>
              {(value: string | null) =>
                value === null
                  ? unavailable
                    ? "Unavailable"
                    : "Mixed"
                  : value === CUSTOM_SHELL_SELECT_VALUE
                    ? "Custom"
                    : shellSettingLabel(value === "auto" ? null : value, shells ?? [])
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false} className="max-w-80">
            <SelectItem value="auto">Automatic</SelectItem>
            {(shells ?? []).map((shell) => (
              <SelectItem key={shell.id} value={shell.id}>
                <ShellOption label={shell.label} command={shell.command} />
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_SHELL_SELECT_VALUE}>Custom…</SelectItem>
          </SelectPopup>
        </Select>
      }
    >
      {showCustom ? (
        <div className="flex flex-col gap-2 pb-2 @min-[32rem]/settings-row:max-w-xl">
          <DraftInput
            size="sm"
            font="mono"
            aria-label="Custom shell executable"
            placeholder="Absolute path to a shell executable"
            value={custom?.command ?? ""}
            onCommit={(next) => {
              const shell = buildCustomShell(next, formatShellArgs(custom?.args));
              if (shell) save(shell);
            }}
          />
          <DraftInput
            size="sm"
            font="mono"
            aria-label="Custom shell arguments"
            placeholder="Arguments, separated by spaces (optional)"
            value={formatShellArgs(custom?.args)}
            disabled={custom === null}
            onCommit={(next) => {
              if (!custom) return;
              const shell = buildCustomShell(custom.command, next);
              if (shell) save(shell);
            }}
          />
        </div>
      ) : selectedProfile ? (
        <div className="flex min-w-0 items-center gap-1 pb-2 font-mono text-xs text-muted-foreground @min-[32rem]/settings-row:max-w-xl">
          <MiddleTruncate value={selectedProfile.command} />
          <DiffFilePathCopyButton filePath={selectedProfile.command} />
        </div>
      ) : null}
    </SettingsRow>
  );
}

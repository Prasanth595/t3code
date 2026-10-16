import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import * as Equal from "effect/Equal";

import type { ScopedSettingsPatch } from "./scopedSettings";

/**
 * Fork: the fork settings that Restore defaults resets, with the label that its confirmation
 * names. Like upstream, Restore defaults resets preferences, and user data and access stay. That
 * keep list is deliberate: `globalScripts` and the pin lists (like project scripts),
 * `sidebarGroups` and `threadCardLayouts` (content that the user built, like keybindings),
 * `machineMap` and `clientAccess` (a reset leaves the map or changes access), and tunnel pairing
 * (desktop connection settings). A new fork preference goes in this list.
 */
const FORK_RESTORED_SETTINGS = [
  ["installedAppEnabled", "Installed app"],
  ["webPushEnabled", "Web Push"],
  ["forkAutoUpdate", "Server auto-update"],
  ["forkChangelogEnabled", "Fork changelog"],
  ["recoverInterruptedTurns", "Recover interrupted agents"],
  ["recoverInterruptedTurnsMessage", "Recover interrupted agents message"],
  ["recoverInterruptedTurnsSubagentMessage", "Recover interrupted subagents message"],
  ["backgroundWorkDetails", "Background work details"],
  ["preferOriginRemote", "Prefer origin remote"],
  ["pullRequestWatchRemarkFilter", "Pull request watch remarks"],
  ["agentSessionImportWindowDays", "Session import window"],
  ["agentSessionImportMaxMessages", "Imported messages per session"],
  ["sidebarGroupsEnabled", "Sidebar groups"],
  ["sidebarGroupSingleThreadOpens", "Single-thread tabs"],
  ["snoozeQuickOptions", "Snooze quick options"],
  ["worktreePathTemplate", "Worktree path template"],
  ["repositoryOwnerFilters", "Repository owner filters"],
  ["pullRequestFilterChips", "Pull request filter chips"],
  ["sidebarOwnerFilter", "Sidebar owner filter"],
  ["appToggleShortcuts", "App toggle shortcuts"],
  ["terminalAppShortcutsFirst", "App shortcuts in terminal"],
  ["confirmTerminalClose", "Terminal close confirmation"],
] as const satisfies ReadonlyArray<
  readonly [keyof UnifiedSettings & keyof ScopedSettingsPatch, string]
>;

/** Fork: the labels of the fork settings that differ from their defaults. */
export function forkChangedSettingLabels(settings: UnifiedSettings): ReadonlyArray<string> {
  return FORK_RESTORED_SETTINGS.flatMap(([key, label]) =>
    Equal.equals(settings[key], DEFAULT_UNIFIED_SETTINGS[key]) ? [] : [label],
  );
}

type ForkRestoredSettingKey = (typeof FORK_RESTORED_SETTINGS)[number][0];

/**
 * Fork: the patch that Restore defaults applies to the fork settings. Each value is read from
 * `DEFAULT_UNIFIED_SETTINGS` by its own key, so the cast only restores the key-to-value pairing
 * that `Object.fromEntries` drops.
 */
export const FORK_SETTINGS_RESTORE_PATCH = Object.fromEntries(
  FORK_RESTORED_SETTINGS.map(([key]) => [key, DEFAULT_UNIFIED_SETTINGS[key]]),
) as Pick<UnifiedSettings, ForkRestoredSettingKey> satisfies ScopedSettingsPatch;

import { ForkClientSettingsFields, ForkServerSettingsFields } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { forkSettingGroups } from "./forkSettingsCatalog";
import { FORK_SETTINGS_RESTORE_PATCH } from "./forkSettingsRestore";
import type { SettingsSearchItemId } from "./settingsSearch";

// Fork: a new fork setting must show on Settings > Fork and reset with Restore defaults.
// docs/fork/operations.md "Change the fork" names both places.

type ForkSettingKey = keyof typeof ForkClientSettingsFields | keyof typeof ForkServerSettingsFields;

/**
 * The search id of the Fork page row of each fork setting, or the reason that it has no row.
 * A new key fails typecheck here first.
 */
const FORK_PAGE_ROWS: Record<
  ForkSettingKey,
  SettingsSearchItemId | { readonly notListed: string }
> = {
  confirmTerminalClose: "terminal-close-confirmation",
  terminalAppShortcutsFirst: "terminal-app-shortcuts-first",
  appToggleShortcuts: "app-toggle-shortcuts",
  backgroundWorkDetails: "background-work-details",
  forkChangelogEnabled: "fork-changelog",
  checkNewerBeforeUpdateInstall: "check-newer-before-update-install",
  installedAppEnabled: "installed-app",
  webPushEnabled: "web-push",
  repositoryOwnerFilters: "repository-owner-filters",
  pullRequestFilterChips: "pull-request-filter-chips",
  sidebarOwnerFilter: { notListed: "The sidebar owner filter menu sets it." },
  sidebarGroupsEnabled: "sidebar-groups",
  sidebarGroupSingleThreadOpens: "sidebar-group-single-thread",
  snoozeQuickOptions: "snooze-quick-options",
  keyboardFocusLevels: "keyboard-focus-levels",
  focusLevelHighlight: "focus-level-highlight",
  tooltipShortcuts: "tooltip-shortcuts",
  tooltipShortcutLimit: "tooltip-shortcut-limit",
  worktreePathTemplate: "storage-worktree-path-template",
  recoverInterruptedTurns: "recover-interrupted-turns",
  recoverInterruptedTurnsMessage: "recover-interrupted-turns",
  recoverInterruptedTurnsSubagentMessage: "recover-interrupted-turns",
  forkAutoUpdate: "fork-auto-update",
  globalScripts: "global-scripts",
  pinnedGlobalScriptIds: { notListed: "The pin buttons of the scripts set it." },
  pinnedProjectScriptIds: { notListed: "The pin buttons of the scripts set it." },
  agentSessionImportWindowDays: "agent-session-import-window",
  agentSessionImportMaxMessages: "agent-session-import-max-messages",
  pullRequestWatchRemarkFilter: "pull-request-watch-roles",
  preferOriginRemote: "prefer-origin-remote",
  threadLinkChips: "thread-link-chips",
  threadLinksOpenDesktopApp: "thread-links-open-desktop-app",
  machineMap: "machine-map",
  clientAccess: {
    notListed: "The portal sets it. Settings > Machines holds the way back in (MM-919).",
  },
  threadCardLayouts: "thread-card-layout",
  sidebarGroups: { notListed: "Content that the user builds in the sidebar." },
  keybindingSync: "keybinding-sync",
  previewLocalServerGroups: "preview-local-server-groups",
  mobilePublishedThemes: "mobile-published-themes",
  mobileNewThreadProject: "mobile-new-thread-project",
  mobileComposerCamera: "mobile-composer-camera",
};

/** The settings that Restore defaults keeps, with the reason. */
const KEPT_BY_RESTORE: Partial<Record<ForkSettingKey, string>> = {
  globalScripts: "User data, like project scripts.",
  pinnedGlobalScriptIds: "User data, like project scripts.",
  pinnedProjectScriptIds: "User data, like project scripts.",
  sidebarGroups: "Content that the user built, like keybindings.",
  threadCardLayouts: "Content that the user built, like keybindings.",
  machineMap: "A reset leaves the machine map.",
  clientAccess: "A reset changes access.",
};

const forkSettingKeys = [
  ...Object.keys(ForkClientSettingsFields),
  ...Object.keys(ForkServerSettingsFields),
] as ReadonlyArray<ForkSettingKey>;

describe("fork settings registration", () => {
  it("lists each fork setting on Settings > Fork", () => {
    const catalogIds = new Set<string>(
      forkSettingGroups.flatMap((group) => group.entries.flatMap((entry) => entry.ids)),
    );
    const missing = forkSettingKeys.flatMap((key) => {
      const row = FORK_PAGE_ROWS[key];
      if (row === undefined) {
        return [
          `${key}: add it to FORK_PAGE_ROWS in apps/web/src/components/settings/forkSettingsRegistration.test.ts`,
        ];
      }
      if (typeof row !== "string" || catalogIds.has(row)) return [];
      return [
        `${key}: add "${row}" to FORK_SETTING_GROUPS in apps/web/src/components/settings/forkSettingsCatalog.ts`,
      ];
    });
    expect(missing).toEqual([]);
  });

  it("resets or deliberately keeps each fork setting on Restore defaults", () => {
    const missing = forkSettingKeys
      .filter((key) => !(key in FORK_SETTINGS_RESTORE_PATCH) && KEPT_BY_RESTORE[key] === undefined)
      .map(
        (key) =>
          `${key}: add it to FORK_RESTORED_SETTINGS in apps/web/src/components/settings/forkSettingsRestore.ts`,
      );
    expect(missing).toEqual([]);
  });
});

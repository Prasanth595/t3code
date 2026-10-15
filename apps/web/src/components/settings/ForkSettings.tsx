import { Link } from "@tanstack/react-router";
import { useMemo, type ComponentType } from "react";

import { Button } from "../ui/button";
import { AppToggleShortcutsSettingsRow } from "./AppToggleShortcutsSettingsRow";
import { ForkChangelogSettingsRow } from "./ForkChangelogSettingsRow";
import {
  AgentSessionImportSettingsRows,
  BackgroundWorkDetailsSettingsRow,
  ForkAutoUpdateSettingsRow,
  TerminalAppShortcutsFirstSettingsRow,
  TerminalCloseConfirmationSettingsRow,
} from "./ForkSettingsRows";
import { GlobalScriptsSettingsRows } from "./GlobalScriptsSettings";
import { InstalledAppSettingsRow } from "./InstalledAppSettingsRow";
import { MachineMapSettingsRows } from "./MachinesSettings";
import { PreferOriginRemoteSettingsRow } from "./PreferOriginRemoteSettings";
import { PullRequestFilterChipsSettingsRow } from "./PullRequestFilterChipsSettingsRow";
import { PullRequestWatchSettingsRows } from "./PullRequestWatchSettings";
import { RecoverInterruptedTurnsSettings } from "./RecoverInterruptedTurnsSettings";
import { RepositoryOwnerFiltersSettingsRow } from "./RepositoryOwnerFiltersSettingsRow";
import { AboutVersionSection } from "./SettingsPanels";
import { useSettingsScope } from "./SettingsScopeContext";
import { SidebarGroupsSettingsRow } from "./SidebarGroupsSettingsRow";
import { SnoozeQuickOptionsSettingsRow } from "./SnoozeQuickOptionsSettingsRow";
import { WorktreesDirectoryRow } from "./StorageSettings";
import { ThreadCardLayoutSettingsRows } from "./ThreadCardLayoutSettings";
import { TunnelPairingSettingsRow } from "./TunnelPairingSettingsRow";
import { WorktreePathTemplateRow } from "./WorktreePathTemplateRow";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  isSettingsSearchItemOnPlatform,
  SETTINGS_SECTION_LABELS,
  type SettingsSearchItem,
  type SettingsSearchItemId,
} from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";

/**
 * One setting on the Fork page. `ids` are the search ids of the rows that `Row` renders; the
 * first one is the link to the usual place. An upstream setting that the fork changed has a
 * `change` note. An upstream row that is not its own component has no `Row`: the page shows its
 * title, the note and a link to it.
 */
type ForkSettingEntry =
  | {
      readonly ids: readonly [SettingsSearchItemId, ...SettingsSearchItemId[]];
      readonly Row: ComponentType;
      readonly change?: string;
    }
  | {
      readonly ids: readonly [SettingsSearchItemId];
      readonly Row?: undefined;
      readonly change: string;
    };

/**
 * Fork: every fork setting and every upstream setting that the fork changed, in the groups of
 * the README "Fork features" section. Each row is the component of its usual place, so both
 * places edit the same value. Add a new fork setting here.
 */
const FORK_SETTING_GROUPS: ReadonlyArray<{
  readonly title: string;
  readonly entries: ReadonlyArray<ForkSettingEntry>;
}> = [
  {
    title: "Remote access",
    entries: [
      { ids: ["tunnel-pairing"], Row: TunnelPairingSettingsRow },
      { ids: ["installed-app"], Row: InstalledAppSettingsRow },
    ],
  },
  {
    title: "Updates and releases",
    entries: [
      {
        ids: ["update-track", "app-version"],
        Row: AboutVersionSection,
        change:
          "Fork: installs fork releases, never downgrades, and offers Install when idle while agents run.",
      },
      { ids: ["fork-auto-update"], Row: ForkAutoUpdateSettingsRow },
      { ids: ["fork-changelog"], Row: ForkChangelogSettingsRow },
    ],
  },
  {
    title: "Agents",
    entries: [
      { ids: ["recover-interrupted-turns"], Row: RecoverInterruptedTurnsSettings },
      {
        ids: ["continue-threads-after-server-update"],
        change:
          "Fork: while Recover interrupted agents is on, cut-off threads continue also when this is off.",
      },
      { ids: ["background-work-details"], Row: BackgroundWorkDetailsSettingsRow },
      { ids: ["prefer-origin-remote"], Row: PreferOriginRemoteSettingsRow },
      {
        ids: [
          "pull-request-watch-roles",
          "pull-request-watch-logins",
          "pull-request-watch-agent-marker",
        ],
        Row: PullRequestWatchSettingsRows,
      },
      {
        ids: ["agent-session-import-window", "agent-session-import-max-messages"],
        Row: AgentSessionImportSettingsRows,
      },
    ],
  },
  {
    title: "Threads",
    entries: [
      { ids: ["sidebar-groups", "sidebar-group-single-thread"], Row: SidebarGroupsSettingsRow },
      { ids: ["snooze-quick-options"], Row: SnoozeQuickOptionsSettingsRow },
      { ids: ["storage-worktree-path-template"], Row: WorktreePathTemplateRow },
      {
        ids: ["storage-worktrees-location"],
        Row: WorktreesDirectoryRow,
        change: "Fork: a worktree path template, when set, replaces this location.",
      },
    ],
  },
  {
    title: "Filters",
    entries: [
      { ids: ["repository-owner-filters"], Row: RepositoryOwnerFiltersSettingsRow },
      { ids: ["pull-request-filter-chips"], Row: PullRequestFilterChipsSettingsRow },
    ],
  },
  {
    title: "Scripts and terminal",
    entries: [
      { ids: ["global-scripts"], Row: GlobalScriptsSettingsRows },
      { ids: ["app-toggle-shortcuts"], Row: AppToggleShortcutsSettingsRow },
      { ids: ["terminal-app-shortcuts-first"], Row: TerminalAppShortcutsFirstSettingsRow },
      { ids: ["terminal-close-confirmation"], Row: TerminalCloseConfirmationSettingsRow },
    ],
  },
  {
    title: "Themes and look",
    entries: [{ ids: ["thread-card-layout"], Row: ThreadCardLayoutSettingsRows }],
  },
  {
    title: "Command line and MCP",
    entries: [{ ids: ["machine-map"], Row: MachineMapSettingsRows }],
  },
];

/**
 * Search results for the rows of the Fork page. Each one copies the result of the usual place,
 * so it has the same scope and availability, and sorts after it.
 */
export function forkSettingsSearchItems(
  available: ReadonlyArray<SettingsSearchItem>,
): ReadonlyArray<SettingsSearchItem> {
  const availableById = new Map(available.map((item) => [item.id, item] as const));
  return FORK_SETTING_GROUPS.flatMap((group) =>
    group.entries.flatMap((entry) =>
      entry.ids.flatMap((id) => {
        const item = availableById.get(id);
        if (item === undefined) return [];
        return [
          {
            ...item,
            id: `fork-${item.id}`,
            targetId: item.id,
            to: "/settings/fork" as const,
            secondary: true,
          },
        ];
      }),
    ),
  );
}

/** Opens the row of `item` in its usual place, the way a search result does. */
function usualPlaceLinkProps(item: SettingsSearchItem) {
  return {
    to: item.to,
    hash: item.id,
    hashScrollIntoView: false,
    state: { settingsTargetHighlight: true },
  } as const;
}

export function ForkSettingsPanel() {
  const { search } = useSettingsScope();
  const available = useAvailableSettingsSearchItems(search);
  const availableById = useMemo(
    () => new Map(available.map((item) => [item.id, item] as const)),
    [available],
  );
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;

  return (
    <SettingsPageContainer>
      {FORK_SETTING_GROUPS.map((group) => {
        // An entry shows where each of its rows can render, like a search result.
        const entries = group.entries.flatMap((entry) => {
          const items = entry.ids.map((id) => availableById.get(id));
          const [item] = items;
          return item !== undefined &&
            items.every(
              (candidate) =>
                candidate !== undefined && isSettingsSearchItemOnPlatform(candidate, platform),
            )
            ? [{ entry, item }]
            : [];
        });
        if (entries.length === 0) return null;
        return (
          <SettingsSection key={group.title} title={group.title}>
            {entries.map(({ entry, item }) =>
              entry.Row === undefined ? (
                <SettingsRow
                  key={item.id}
                  id={item.id}
                  title={item.title}
                  description={entry.change}
                  control={
                    <Button
                      size="sm"
                      variant="outline"
                      render={<Link {...usualPlaceLinkProps(item)} />}
                    >
                      Open in {SETTINGS_SECTION_LABELS[item.to]}
                    </Button>
                  }
                />
              ) : (
                // A row can render nothing, for example at a project scope. Its note then hides too.
                <div key={item.id} className="[&:not(:has([data-slot=settings-row]))]:hidden">
                  <entry.Row />
                  <p className="-mt-1 px-3 pb-3 text-xs text-muted-foreground sm:px-4">
                    {item.desktopOnly ? "Desktop app only. " : ""}
                    {entry.change ? `${entry.change} ` : ""}
                    Also in{" "}
                    <Link {...usualPlaceLinkProps(item)} className="underline underline-offset-2">
                      {SETTINGS_SECTION_LABELS[item.to]}
                    </Link>
                    .
                  </p>
                </div>
              ),
            )}
          </SettingsSection>
        );
      })}
    </SettingsPageContainer>
  );
}

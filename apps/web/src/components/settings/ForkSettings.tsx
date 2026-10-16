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
import { ThreadLinkChipsSettingsRow } from "./ThreadLinkChipsSettings";
import { TunnelPairingSettingsRow } from "./TunnelPairingSettingsRow";
import { WorktreePathTemplateRow } from "./WorktreePathTemplateRow";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { forkSettingGroups, type ForkSettingRowId } from "./forkSettingsCatalog";
import {
  getSettingsSearchTargetScope,
  isSettingsSearchItemOnPlatform,
  isSettingsSearchScopeAvailable,
  SETTINGS_SECTION_LABELS,
  type SettingsSearchItem,
} from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";

/**
 * The row component of each Fork page entry: the same component as on its usual page, so both
 * places edit the same value. The type requires one for every catalog entry that is not
 * link-only.
 */
const FORK_SETTING_ROWS: Readonly<Record<ForkSettingRowId, ComponentType>> = {
  "tunnel-pairing": TunnelPairingSettingsRow,
  "installed-app": InstalledAppSettingsRow,
  "update-track": AboutVersionSection,
  "fork-auto-update": ForkAutoUpdateSettingsRow,
  "fork-changelog": ForkChangelogSettingsRow,
  "recover-interrupted-turns": RecoverInterruptedTurnsSettings,
  "background-work-details": BackgroundWorkDetailsSettingsRow,
  "prefer-origin-remote": PreferOriginRemoteSettingsRow,
  "pull-request-watch-roles": PullRequestWatchSettingsRows,
  "agent-session-import-window": AgentSessionImportSettingsRows,
  "sidebar-groups": SidebarGroupsSettingsRow,
  "snooze-quick-options": SnoozeQuickOptionsSettingsRow,
  "storage-worktree-path-template": WorktreePathTemplateRow,
  "storage-worktrees-location": WorktreesDirectoryRow,
  "repository-owner-filters": RepositoryOwnerFiltersSettingsRow,
  "pull-request-filter-chips": PullRequestFilterChipsSettingsRow,
  "global-scripts": GlobalScriptsSettingsRows,
  "app-toggle-shortcuts": AppToggleShortcutsSettingsRow,
  "terminal-app-shortcuts-first": TerminalAppShortcutsFirstSettingsRow,
  "terminal-close-confirmation": TerminalCloseConfirmationSettingsRow,
  "thread-card-layout": ThreadCardLayoutSettingsRows,
  "thread-link-chips": ThreadLinkChipsSettingsRow,
  "machine-map": MachineMapSettingsRows,
};

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
  const { search, scope } = useSettingsScope();
  const available = useAvailableSettingsSearchItems(search);
  const availableById = useMemo(
    () => new Map(available.map((item) => [item.id, item] as const)),
    [available],
  );
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;

  return (
    <SettingsPageContainer>
      {forkSettingGroups.map((group) => {
        // An entry shows where search reaches its first row, and each other row that search
        // lists: on this platform and at the selected scope. Storage, for example, hides its
        // worktree rows at a project scope. A row that its own setting hides, such as
        // "Single-thread tabs" while sidebar groups are off, is not listed and does not count.
        const entries = group.entries.flatMap((entry) => {
          const items = entry.ids.map((id) => availableById.get(id));
          const [item] = items;
          return item !== undefined &&
            items.every(
              (candidate) =>
                candidate === undefined ||
                (isSettingsSearchItemOnPlatform(candidate, platform) &&
                  isSettingsSearchScopeAvailable(
                    getSettingsSearchTargetScope(candidate.id)?.scope ?? null,
                    scope.kind,
                  )),
            )
            ? [{ entry, item }]
            : [];
        });
        if (entries.length === 0) return null;
        return (
          // A row can render nothing, for example the machine map without an environment. An
          // entry or a group without a rendered row hides.
          <SettingsSection
            key={group.title}
            title={group.title}
            className="[&:not(:has([data-slot=settings-row]))]:hidden"
          >
            {entries.map(({ entry, item }) => {
              if ("linkOnly" in entry) {
                return (
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
                );
              }
              const Row = FORK_SETTING_ROWS[entry.ids[0]];
              return (
                <div key={item.id} className="[&:not(:has([data-slot=settings-row]))]:hidden">
                  <Row />
                  <p className="-mt-1 px-3 pb-3 text-xs text-muted-foreground sm:px-4">
                    {item.desktopOnly ? "Desktop app only. " : ""}
                    {"change" in entry ? `${entry.change} ` : ""}
                    Also in{" "}
                    <Link {...usualPlaceLinkProps(item)} className="underline underline-offset-2">
                      {SETTINGS_SECTION_LABELS[item.to]}
                    </Link>
                    .
                  </p>
                </div>
              );
            })}
          </SettingsSection>
        );
      })}
    </SettingsPageContainer>
  );
}

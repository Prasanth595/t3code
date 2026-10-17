/**
 * Fork: the state of the sidebar owner filter, kept out of `Sidebar.tsx` so that the upstream
 * file changes little. If upstream T3 Code ships an owner or organization filter for the sidebar,
 * drop this fork version and use theirs.
 */
import type { SidebarOwnerFilter } from "@t3tools/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import type { ProjectGroupingSettings } from "../../logicalProject";
import {
  resolveSidebarProjectScopeKey,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import {
  buildSidebarOwnerOptions,
  countHiddenThreadsNeedingUser,
  filterSidebarProjectGroupsByOwner,
  resolveSidebarOwnerFilter,
  sidebarProjectGroupMemberKeys,
} from "./ownerFilter.logic";

/**
 * The keys come from the unsorted groups, which keep their identity while threads stream, so the
 * keys and the rows that read them stay stable.
 */
export function useSidebarOwnerFilter<Group extends SidebarProjectSnapshot>(input: {
  readonly unsortedProjectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  /** The sorted groups, for the project scope menu. */
  readonly projectGroups: ReadonlyArray<Group>;
  readonly projectGroupingSettings: ProjectGroupingSettings;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
}) {
  const { unsortedProjectGroups, projectGroups, projectGroupingSettings } = input;
  // Counts cover the threads the sidebar lists: no archived threads and no subagents.
  const threads = filterSidebarV2VisibleThreads(input.threads, null);
  const repositoryOwnerFiltersEnabled = useClientSettings((s) => s.repositoryOwnerFilters);
  const savedOwnerFilter = useClientSettings((s) => s.sidebarOwnerFilter);
  const updateClientSettings = useUpdateClientSettings();
  const ownerFilter = resolveSidebarOwnerFilter({
    enabled: repositoryOwnerFiltersEnabled,
    filter: savedOwnerFilter,
  });
  const ownerOptions = repositoryOwnerFiltersEnabled
    ? buildSidebarOwnerOptions(unsortedProjectGroups, threads, savedOwnerFilter.owners)
    : [];
  const ownerVisibleGroups = filterSidebarProjectGroupsByOwner(unsortedProjectGroups, ownerFilter);
  const ownerVisibleProjectKeys =
    ownerFilter === null ? null : sidebarProjectGroupMemberKeys(ownerVisibleGroups);
  const visibleProjectGroups = filterSidebarProjectGroupsByOwner(projectGroups, ownerFilter);
  const setOwnerFilter = (filter: SidebarOwnerFilter) => {
    // A selection made under one owner filter can hold threads the next one hides.
    useThreadSelectionStore.getState().clearSelection();
    void updateClientSettings({ sidebarOwnerFilter: filter });
    // An owner change that hides the scoped project drops the scope too, so that the scope
    // cannot come back unseen when the owner filter goes.
    const { sidebarProjectScopeKey, setSidebarProjectScopeKey } = useUiStateStore.getState();
    const visible = filterSidebarProjectGroupsByOwner(
      unsortedProjectGroups,
      resolveSidebarOwnerFilter({ enabled: repositoryOwnerFiltersEnabled, filter }),
    );
    const scopeShows =
      resolveSidebarProjectScopeKey({
        groups: visible,
        key: sidebarProjectScopeKey,
        settings: projectGroupingSettings,
        canClearMissingScope: true,
      }) !== null;
    if (sidebarProjectScopeKey !== null && !scopeShows) setSidebarProjectScopeKey(null);
  };
  const ownerHiddenThreadsNeedingUser = countHiddenThreadsNeedingUser(
    threads,
    ownerVisibleProjectKeys,
  );
  return {
    repositoryOwnerFiltersEnabled,
    savedOwnerFilter,
    ownerFilter,
    ownerOptions,
    ownerVisibleProjectKeys,
    visibleProjectGroups,
    ownerHiddenProjectCount: unsortedProjectGroups.length - ownerVisibleGroups.length,
    ownerHiddenThreadsNeedingUser,
    setOwnerFilter,
  };
}

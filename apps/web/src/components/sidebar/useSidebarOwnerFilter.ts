/**
 * Fork: the state of the sidebar owner filter, kept out of `Sidebar.tsx` so that the upstream
 * file changes little. If upstream T3 Code ships an owner or organization filter for the sidebar,
 * drop this fork version and use theirs.
 */
import type { SidebarOwnerFilter } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import type { ProjectGroupingSettings } from "../../logicalProject";
import {
  resolveSidebarProjectScopeKey,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
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
  readonly threads: ReadonlyArray<Parameters<typeof countHiddenThreadsNeedingUser>[0][number]>;
}) {
  const { unsortedProjectGroups, projectGroups, projectGroupingSettings, threads } = input;
  const repositoryOwnerFiltersEnabled = useClientSettings((s) => s.repositoryOwnerFilters);
  const savedOwnerFilter = useClientSettings((s) => s.sidebarOwnerFilter);
  const updateClientSettings = useUpdateClientSettings();
  const ownerFilter = useMemo(
    () =>
      resolveSidebarOwnerFilter({
        enabled: repositoryOwnerFiltersEnabled,
        filter: savedOwnerFilter,
      }),
    [repositoryOwnerFiltersEnabled, savedOwnerFilter],
  );
  const ownerOptions = useMemo(
    () =>
      repositoryOwnerFiltersEnabled
        ? buildSidebarOwnerOptions(unsortedProjectGroups, threads, savedOwnerFilter.owners)
        : [],
    [repositoryOwnerFiltersEnabled, savedOwnerFilter.owners, threads, unsortedProjectGroups],
  );
  const ownerVisibleGroups = useMemo(
    () => filterSidebarProjectGroupsByOwner(unsortedProjectGroups, ownerFilter),
    [ownerFilter, unsortedProjectGroups],
  );
  const ownerVisibleProjectKeys = useMemo(
    () => (ownerFilter === null ? null : sidebarProjectGroupMemberKeys(ownerVisibleGroups)),
    [ownerFilter, ownerVisibleGroups],
  );
  const visibleProjectGroups = useMemo(
    () => filterSidebarProjectGroupsByOwner(projectGroups, ownerFilter),
    [ownerFilter, projectGroups],
  );
  const setOwnerFilter = useCallback(
    (filter: SidebarOwnerFilter) => {
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
    },
    [
      projectGroupingSettings,
      repositoryOwnerFiltersEnabled,
      unsortedProjectGroups,
      updateClientSettings,
    ],
  );
  return {
    repositoryOwnerFiltersEnabled,
    savedOwnerFilter,
    ownerFilter,
    ownerOptions,
    ownerVisibleProjectKeys,
    visibleProjectGroups,
    ownerHiddenProjectCount: unsortedProjectGroups.length - ownerVisibleGroups.length,
    ownerHiddenThreadsNeedingUser: countHiddenThreadsNeedingUser(threads, ownerVisibleProjectKeys),
    setOwnerFilter,
  };
}

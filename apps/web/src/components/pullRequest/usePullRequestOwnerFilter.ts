/**
 * Fork: the repository owner filter and filter chip parts of the pull request page
 * (`routes/_chat.pull-requests.tsx`). The route calls this module and keeps one line per hook.
 */
import type { ClientSettings, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useMemo } from "react";

import type { FilterOperator } from "../filters/FilterChip";
import type { PullRequestFilterChip } from "./pullRequestFilterChips.logic";
import {
  MAX_PULL_REQUEST_LIST_OWNERS,
  type PullRequestListPreferencePatch,
  type PullRequestListPreferences,
} from "./pullRequestListPreferences";
import {
  type OwnedProject,
  type PullRequestOwnerFilter,
  projectsOfOwners,
  pullRequestMenuOwnerFilter,
  pullRequestOwnerRowFilter,
} from "./pullRequestOwnerFilter.logic";

/** Owners are read like labels, then lowercased to match `repositoryOwnerOf`. */
export function pullRequestSearchOwners(labels: {
  readonly labels?: ReadonlyArray<string>;
}): Partial<Pick<PullRequestListPreferences, "owners">> {
  const owners = labels.labels
    ?.map((owner) => owner.toLowerCase())
    .slice(0, MAX_PULL_REQUEST_LIST_OWNERS);
  return owners === undefined ? {} : { owners };
}

export const selectRepositoryOwnerFilters = (settings: ClientSettings) =>
  settings.repositoryOwnerFilters;
const NO_OWNERS: ReadonlyArray<string> = [];
export const selectPullRequestFilterChips = (settings: ClientSettings) =>
  settings.pullRequestFilterChips;
export const NO_FILTER_CHIPS: ReadonlyArray<PullRequestFilterChip> = [];

/** The search patch of an owner menu change. */
export const ownerMenuPatch = (
  owners: ReadonlyArray<string>,
  operator: FilterOperator,
): PullRequestListPreferencePatch => ({
  owners: owners.length === 0 ? undefined : owners,
  ownerOperator: operator === "is_not" ? operator : undefined,
});

export function usePullRequestOwnerFilter<Project extends OwnedProject>(input: {
  /** The `repositoryOwnerFilters` setting. */
  readonly enabled: boolean;
  readonly search: Pick<PullRequestListPreferences, "owners" | "ownerOperator"> & {
    readonly projectId?: ProjectId | undefined;
    readonly environmentId?: EnvironmentId | undefined;
  };
  readonly projects: ReadonlyArray<Project>;
  /** The owners of the typed and of the sent search text. */
  readonly typedOwners: PullRequestOwnerFilter | undefined;
  readonly sentOwners: PullRequestOwnerFilter | undefined;
}) {
  const { enabled, search, projects, typedOwners, sentOwners } = input;
  // The repository owners that narrow the list. A typed `org:` or `-org:` wins over the menu,
  // the same way the other typed qualifiers win. The request reads the sent text, and the rows
  // on screen read the typed text at once.
  const menuOwners = enabled ? (search.owners ?? NO_OWNERS) : NO_OWNERS;
  const menuOwnerOperator: FilterOperator = search.ownerOperator ?? "is";
  const menuOwnerFilter = useMemo(
    () => pullRequestMenuOwnerFilter(menuOwners, menuOwnerOperator),
    [menuOwnerOperator, menuOwners],
  );
  const requestOwners = sentOwners ?? menuOwnerFilter;
  const localOwners = typedOwners ?? menuOwnerFilter;
  // The projects that the list asks about. The project scope, the project menu and the
  // per-server split read these. The selection reads every project, because a link can open a
  // pull request from any owner.
  const listProjects = useMemo(
    () => projectsOfOwners(projects, requestOwners),
    [projects, requestOwners],
  );
  const keepRequestOwnerRow = useMemo(
    () => pullRequestOwnerRowFilter(projects, requestOwners),
    [projects, requestOwners],
  );
  const keepLocalOwnerRow = useMemo(
    () =>
      localOwners === requestOwners
        ? keepRequestOwnerRow
        : pullRequestOwnerRowFilter(projects, localOwners),
    [keepRequestOwnerRow, localOwners, projects, requestOwners],
  );
  // An owner change that leaves the scoped project out drops the project scope too, the same
  // way picking another server does. The owner menu and the owner chip both pass here.
  const withOwnerScope = (
    patch: PullRequestListPreferencePatch,
  ): PullRequestListPreferencePatch => {
    if (!("owners" in patch) && !("ownerOperator" in patch)) return patch;
    const owners = "owners" in patch ? (patch.owners ?? NO_OWNERS) : menuOwners;
    const operator = "ownerOperator" in patch ? (patch.ownerOperator ?? "is") : menuOwnerOperator;
    const kept = projectsOfOwners(projects, pullRequestMenuOwnerFilter(owners, operator));
    const keepsScope =
      search.projectId === undefined ||
      kept.some(
        (project) =>
          project.id === search.projectId &&
          (search.environmentId === undefined || project.environmentId === search.environmentId),
      );
    return keepsScope ? patch : { ...patch, projectId: undefined };
  };
  return {
    menuOwners,
    menuOwnerOperator,
    listProjects,
    keepRequestOwnerRow,
    keepLocalOwnerRow,
    withOwnerScope,
  };
}

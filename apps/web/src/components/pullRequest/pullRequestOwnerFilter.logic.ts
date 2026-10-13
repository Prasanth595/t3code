/**
 * Fork: the repository owner filter of the pull request page. If upstream T3 Code ships an owner
 * or organization filter for pull requests, drop this fork version and use theirs.
 */
import {
  repositoryOwnerOf,
  type EnvironmentId,
  type ProjectId,
  type RepositoryIdentity,
} from "@t3tools/contracts";

import type { FilterOperator } from "../filters/FilterChip";
import { pullRequestProjectKey } from "./PullRequestListFilters";

/** Fork: the part of a project that the repository owner filter reads. */
interface OwnedProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

/**
 * Fork: owners to keep and owners to drop, lowercase. An empty `include` keeps every owner, and
 * `exclude` then drops some. The menu fills one of the two lists. Typed `org:` and `-org:`
 * qualifiers can fill both.
 */
export interface PullRequestOwnerFilter {
  readonly include: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
}

export const NO_PULL_REQUEST_OWNER_FILTER: PullRequestOwnerFilter = { include: [], exclude: [] };

/** Fork: the menu filter, one operator for all of its owners. */
export function pullRequestMenuOwnerFilter(
  owners: ReadonlyArray<string>,
  operator: FilterOperator,
): PullRequestOwnerFilter {
  return operator === "is" ? { include: owners, exclude: [] } : { include: [], exclude: owners };
}

const isEmptyOwnerFilter = (filter: PullRequestOwnerFilter) =>
  filter.include.length === 0 && filter.exclude.length === 0;

/** Lowercase, so that the filter compares owners without case. Null without a repository. */
function ownerOf(project: OwnedProject): string | null {
  if (!project.repositoryIdentity) return null;
  return repositoryOwnerOf(project.repositoryIdentity)?.toLowerCase() ?? null;
}

/**
 * Fork: the owners for the owner menu: the distinct owners of the projects that have threads,
 * sorted. An owner of cloned repositories without threads is not offered.
 */
export function pullRequestProjectOwners(
  projects: ReadonlyArray<OwnedProject>,
  threads: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly projectId: ProjectId }>,
): ReadonlyArray<string> {
  const withThreads = new Set(
    threads.map((thread) =>
      pullRequestProjectKey({ id: thread.projectId, environmentId: thread.environmentId }),
    ),
  );
  const owners = new Set<string>();
  for (const project of projects) {
    if (!withThreads.has(pullRequestProjectKey(project))) continue;
    const owner = ownerOf(project);
    if (owner !== null) owners.add(owner);
  }
  return [...owners].toSorted((left, right) => left.localeCompare(right));
}

/**
 * Fork: the projects that the owner filter keeps, compared without case. With an empty filter,
 * it returns the same array, so memos that read it stay stable. A project without a repository
 * has no owner: a list of owners to keep drops it, and a list of owners to drop keeps it.
 */
export function projectsOfOwners<Project extends OwnedProject>(
  projects: ReadonlyArray<Project>,
  filter: PullRequestOwnerFilter,
): ReadonlyArray<Project> {
  if (isEmptyOwnerFilter(filter)) return projects;
  const include = new Set(filter.include.map((owner) => owner.toLowerCase()));
  const exclude = new Set(filter.exclude.map((owner) => owner.toLowerCase()));
  return projects.filter((project) => {
    const owner = ownerOf(project);
    if (include.size > 0 && (owner === null || !include.has(owner))) return false;
    return owner === null || !exclude.has(owner);
  });
}

/**
 * Fork: a test that keeps a listed row only when the owner filter keeps its project. A project id
 * is unique only on its own server, so the server is part of the match. Null for an empty filter,
 * so callers skip the pass.
 */
export function pullRequestOwnerRowFilter(
  projects: ReadonlyArray<OwnedProject>,
  filter: PullRequestOwnerFilter,
):
  | ((row: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId }) => boolean)
  | null {
  if (isEmptyOwnerFilter(filter)) return null;
  const known = new Set(projects.map(pullRequestProjectKey));
  const kept = new Set(projectsOfOwners(projects, filter).map(pullRequestProjectKey));
  // A row of a project that the page does not know yet has no known owner. Like a project
  // without a repository, it stays while the filter only hides owners.
  const keepsUnknown = filter.include.length === 0;
  return (row) => {
    const key = pullRequestProjectKey({ id: row.projectId, environmentId: row.environmentId });
    return known.has(key) ? kept.has(key) : keepsUnknown;
  };
}

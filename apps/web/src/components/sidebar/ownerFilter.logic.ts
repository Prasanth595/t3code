/**
 * Fork: the sidebar owner filter. It shows only the projects whose repository owner
 * (`repositoryOwnerOf`) is selected, and the threads of those projects.
 */
import { repositoryOwnerOf } from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";

/** A repository owner, or null for a project without one (no remote, or a scratch project). */
export type SidebarOwner = string | null;

/** The owner of a project group. All members share the grouping identity, so they share the owner. */
export function sidebarProjectGroupOwner(
  group: Pick<SidebarProjectSnapshot, "repositoryIdentity">,
): SidebarOwner {
  return group.repositoryIdentity ? repositoryOwnerOf(group.repositoryIdentity) : null;
}

export function sidebarOwnerLabel(owner: SidebarOwner): string {
  return owner ?? "No repository owner";
}

/** The active selection, or null when the filter shows every project. */
export function resolveSidebarOwnerFilter(input: {
  readonly enabled: boolean;
  readonly owners: readonly SidebarOwner[];
}): ReadonlySet<SidebarOwner> | null {
  return input.enabled && input.owners.length > 0 ? new Set(input.owners) : null;
}

export interface SidebarOwnerOption {
  readonly owner: SidebarOwner;
  readonly projectCount: number;
}

/**
 * The menu entries: each owner of the groups with its project count. A selected owner that no
 * group has stays in the list with a zero count, so the user can clear it. Owners sort by name,
 * and the entry for projects without an owner comes last.
 */
export function buildSidebarOwnerOptions(
  groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "repositoryIdentity">>,
  selected: readonly SidebarOwner[],
): SidebarOwnerOption[] {
  const projectCountByOwner = new Map<SidebarOwner, number>();
  for (const group of groups) {
    const owner = sidebarProjectGroupOwner(group);
    projectCountByOwner.set(owner, (projectCountByOwner.get(owner) ?? 0) + 1);
  }
  for (const owner of selected) {
    if (!projectCountByOwner.has(owner)) projectCountByOwner.set(owner, 0);
  }
  return [...projectCountByOwner]
    .map(([owner, projectCount]) => ({ owner, projectCount }))
    .toSorted((left, right) =>
      left.owner === null ? 1 : right.owner === null ? -1 : left.owner.localeCompare(right.owner),
    );
}

/** The groups whose owner is selected. A null filter returns the same array. */
export function filterSidebarProjectGroupsByOwner<
  T extends Pick<SidebarProjectSnapshot, "repositoryIdentity">,
>(groups: readonly T[], filter: ReadonlySet<SidebarOwner> | null): readonly T[] {
  if (filter === null) return groups;
  return groups.filter((group) => filter.has(sidebarProjectGroupOwner(group)));
}

/** The `environmentId:projectId` keys of the groups' member projects, the key that threads match. */
export function sidebarProjectGroupMemberKeys(
  groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "memberProjectRefs">>,
): ReadonlySet<string> {
  return new Set(
    groups.flatMap((group) =>
      group.memberProjectRefs.map(
        (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
      ),
    ),
  );
}

type OwnerFilterThread = Pick<
  SidebarThreadSummary,
  "environmentId" | "projectId" | "hasPendingApprovals" | "hasPendingUserInput" | "runtime"
>;

/**
 * A thread that runs or waits for an approval or an answer keeps its row while the filter hides
 * its project, so that work does not stop out of sight. When it finishes, the filter hides it.
 */
export function keepsSidebarRowUnderOwnerFilter(thread: OwnerFilterThread): boolean {
  const status = resolveSidebarThreadStatus(thread);
  return status === "approval" || status === "input" || status === "working";
}

/**
 * The threads in the visible projects, plus the threads that `keepsSidebarRowUnderOwnerFilter`
 * keeps. Null keys mean no filter and return the same array.
 */
export function filterSidebarThreadsByOwner<T extends OwnerFilterThread>(
  threads: readonly T[],
  visibleProjectKeys: ReadonlySet<string> | null,
): readonly T[] {
  if (visibleProjectKeys === null) return threads;
  return threads.filter(
    (thread) =>
      visibleProjectKeys.has(`${thread.environmentId}:${thread.projectId}`) ||
      keepsSidebarRowUnderOwnerFilter(thread),
  );
}

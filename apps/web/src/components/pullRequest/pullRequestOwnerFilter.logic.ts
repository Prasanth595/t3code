import { repositoryOwnerOf, type RepositoryIdentity } from "@t3tools/contracts";

/** Fork: the part of a project that the repository owner filter reads. */
interface OwnedProject {
  readonly id: string;
  readonly environmentId: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

/** Lowercase, so that the filter compares owners without case. Null without a repository. */
function ownerOf(project: OwnedProject): string | null {
  if (!project.repositoryIdentity) return null;
  return repositoryOwnerOf(project.repositoryIdentity)?.toLowerCase() ?? null;
}

/** Fork: the distinct owners of these projects, sorted, for the owner menu. */
export function pullRequestProjectOwners(
  projects: ReadonlyArray<OwnedProject>,
): ReadonlyArray<string> {
  const owners = new Set<string>();
  for (const project of projects) {
    const owner = ownerOf(project);
    if (owner !== null) owners.add(owner);
  }
  return [...owners].toSorted((left, right) => left.localeCompare(right));
}

/**
 * Fork: the projects whose repository owner is one of `owners`, compared without case. With no
 * owners, it returns the same array, so memos that read it stay stable. A project without a
 * repository has no owner, so an owner selection always drops it.
 */
export function projectsOfOwners<Project extends OwnedProject>(
  projects: ReadonlyArray<Project>,
  owners: ReadonlyArray<string>,
): ReadonlyArray<Project> {
  if (owners.length === 0) return projects;
  const wanted = new Set(owners.map((owner) => owner.toLowerCase()));
  return projects.filter((project) => {
    const owner = ownerOf(project);
    return owner !== null && wanted.has(owner);
  });
}

/**
 * Fork: a test that keeps a listed row only when its project belongs to one of `owners`. A
 * project id is unique only on its own server, so the server is part of the match. Null when no
 * owner is selected, so callers skip the pass.
 */
export function pullRequestOwnerRowFilter(
  projects: ReadonlyArray<OwnedProject>,
  owners: ReadonlyArray<string>,
): ((row: { readonly environmentId: string; readonly projectId: string }) => boolean) | null {
  if (owners.length === 0) return null;
  const keys = new Set(
    projectsOfOwners(projects, owners).map((project) =>
      JSON.stringify([project.environmentId, project.id]),
    ),
  );
  return (row) => keys.has(JSON.stringify([row.environmentId, row.projectId]));
}

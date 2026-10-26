import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { repositoryGroupingKeyOf, type EnvironmentId } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" };

export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  suggestedProjectKey?: string,
): EnvironmentProject {
  return (
    scope.projects.find(
      (project) => scopedProjectKey(project.environmentId, project.id) === suggestedProjectKey,
    ) ??
    scope.projects.find((project) => project.environmentId === preferredEnvironmentId) ??
    scope.representative
  );
}

export function filterProjectScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  searchText: string,
): ReadonlyArray<HomeProjectScope> {
  const query = searchText.trim().toLowerCase();
  if (!query) return scopes;
  return scopes.filter(
    (scope) =>
      scope.title.toLowerCase().includes(query) ||
      scope.projects.some(
        (project) =>
          project.title.toLowerCase().includes(query) ||
          project.workspaceRoot.toLowerCase().includes(query),
      ),
  );
}

function getOnlySelectableProject(
  projectScopes: ReadonlyArray<HomeProjectScope>,
): EnvironmentProject | null {
  const onlyScope = projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope?.representative ?? null;
}

export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): EnvironmentProject | null {
  const repositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  // Use || null: placeholder workspaceRoot can be empty, which supplies no useful basename.
  const workspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  // Use weaker signals only when identity is unknown; different known repositories never match by basename or title.
  const isKnownMismatch = (project: EnvironmentProject) => {
    const projectKey = project.repositoryIdentity
      ? repositoryGroupingKeyOf(project.repositoryIdentity)
      : null;
    return repositoryKey !== null && projectKey !== null && projectKey !== repositoryKey;
  };
  return (
    (repositoryKey !== null
      ? projectsOnTarget.find(
          (project) =>
            (project.repositoryIdentity
              ? repositoryGroupingKeyOf(project.repositoryIdentity)
              : null) === repositoryKey,
        )
      : undefined) ??
    (workspaceBasename !== null
      ? projectsOnTarget.find(
          (project) =>
            !isKnownMismatch(project) &&
            project.workspaceRoot.split("/").at(-1) === workspaceBasename,
        )
      : undefined) ??
    (selectedProject !== null
      ? projectsOnTarget.find(
          (project) => !isKnownMismatch(project) && project.title === selectedProject.title,
        )
      : undefined) ??
    projectsOnTarget[0] ??
    null
  );
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
): DraftProjectSelectionResolution {
  const hasExplicitProjectSelection =
    selectedProjectKey !== null &&
    projects.some(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    );
  if (hasExplicitProjectSelection) {
    return { kind: "preserve" };
  }

  const onlyProject = getOnlySelectableProject(projectScopes);
  return onlyProject ? { kind: "select", project: onlyProject } : { kind: "pick" };
}

/**
 * Where a global "New thread" goes: a draft in the only selectable project, keeping the current
 * project's workspace, or else the picker, which lists the current project first and opens the
 * draft only once a project is chosen.
 */
export function newTaskDestination(
  projectScopes: ReadonlyArray<HomeProjectScope>,
  currentProjectKey: string | undefined,
  requestId: string,
) {
  const onlyScope = projectScopes.length === 1 ? projectScopes[0] : undefined;
  if (onlyScope) {
    const project = getProjectScopeSelectionTarget(onlyScope, null, currentProjectKey);
    return {
      kind: "draft" as const,
      draft: {
        requestId,
        environmentId: String(project.environmentId),
        projectId: String(project.id),
      },
    };
  }
  return {
    kind: "pick" as const,
    picker: { requestId, ...(currentProjectKey ? { suggestedProjectKey: currentProjectKey } : {}) },
  };
}

export function orderSuggestedProjectFirst(
  scopes: ReadonlyArray<HomeProjectScope>,
  suggestedProjectKey: string | undefined,
): ReadonlyArray<HomeProjectScope> {
  const suggested = scopes.find((scope) =>
    scope.projectRefs.some(
      (ref) => scopedProjectKey(ref.environmentId, ref.projectId) === suggestedProjectKey,
    ),
  );
  return suggested ? [suggested, ...scopes.filter((scope) => scope !== suggested)] : scopes;
}

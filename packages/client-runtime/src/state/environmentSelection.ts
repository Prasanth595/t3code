import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Which environment a client view is narrowed to. A view filter only: it never
 * gates writes on the server, and explicit routing choices (the composer's
 * environment picker, auto-balance) do not follow it beyond their default.
 * Not to be confused with `useEnvironmentScope`, which checks auth grants.
 */
export type EnvironmentSelection =
  | { readonly kind: "all" }
  | { readonly kind: "one"; readonly environmentId: EnvironmentId };

export const ALL_ENVIRONMENTS_SELECTION: EnvironmentSelection = Object.freeze({
  kind: "all",
});

export interface EnvironmentSelectionCandidate {
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
  /** Connected right now. Offline environments still serve cached projects. */
  readonly online: boolean;
}

export type ResolvedEnvironmentSelection =
  /** The catalog has not loaded. Callers must not reset or broaden anything. */
  | { readonly status: "pending"; readonly environmentId: EnvironmentId | null }
  | {
      readonly status: "all";
      readonly environmentIds: readonly EnvironmentId[];
    }
  | {
      readonly status: "active";
      readonly environmentId: EnvironmentId;
      readonly online: boolean;
    }
  /** Removed or switched off. Shown as unavailable with an explicit way back to all. */
  | { readonly status: "missing"; readonly environmentId: EnvironmentId };

export function resolveEnvironmentSelection(
  selection: EnvironmentSelection,
  catalogEntries: readonly EnvironmentSelectionCandidate[],
  isReady: boolean,
): ResolvedEnvironmentSelection {
  if (!isReady) {
    return {
      status: "pending",
      environmentId: selection.kind === "one" ? selection.environmentId : null,
    };
  }
  if (selection.kind === "all") {
    return {
      status: "all",
      environmentIds: catalogEntries
        .filter((entry) => entry.enabled)
        .map((entry) => entry.environmentId),
    };
  }
  const entry = catalogEntries.find(
    (candidate) => candidate.enabled && candidate.environmentId === selection.environmentId,
  );
  return entry
    ? {
        status: "active",
        environmentId: entry.environmentId,
        online: entry.online,
      }
    : { status: "missing", environmentId: selection.environmentId };
}

/** The environment a view is narrowed to, or null when it shows every environment. */
export function narrowedEnvironmentId(
  resolved: ResolvedEnvironmentSelection,
): EnvironmentId | null {
  return resolved.status === "all" ? null : resolved.environmentId;
}

/**
 * Narrows projects to the selection. Run it before `buildProjectGroups` so
 * labels, representatives and member refs only come from selected environments.
 * Returns the input unchanged when nothing is narrowed.
 */
export function selectProjectsForEnvironment<T extends { readonly environmentId: EnvironmentId }>(
  projects: readonly T[],
  resolved: ResolvedEnvironmentSelection,
): readonly T[] {
  if (resolved.status === "missing") return [];
  const environmentId = narrowedEnvironmentId(resolved);
  return environmentId === null
    ? projects
    : projects.filter((project) => project.environmentId === environmentId);
}

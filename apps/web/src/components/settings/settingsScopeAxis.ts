import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { EnvironmentPresentation } from "../../state/environments";
import {
  resolveSettingsScope,
  type ResolvedSettingsScope,
  type SettingsScopeSearch,
} from "./settingsScope";

type ScopeEnvironment = Pick<EnvironmentPresentation, "environmentId" | "label" | "displayUrl">;

export const ALL_ENVIRONMENTS_VALUE = "all";
export const ALL_PROJECTS_VALUE = "all";

/**
 * The environment axis: `all` or an environment id. A legacy checkout link
 * without `machine` still names one environment, which the resolver supplies.
 */
export function environmentAxisValue(
  search: SettingsScopeSearch,
  resolvedEnvironmentId?: string | null,
): string {
  return search.machine ?? resolvedEnvironmentId ?? ALL_ENVIRONMENTS_VALUE;
}

/** The project axis: `all` or a project key. */
export function projectAxisValue(search: SettingsScopeSearch): string {
  return search.project ?? ALL_PROJECTS_VALUE;
}

/** Choosing an environment keeps the project; a pre-existing checkout narrowing is dropped. */
export function selectEnvironmentAxis(
  search: SettingsScopeSearch,
  value: string,
): SettingsScopeSearch {
  const next: SettingsScopeSearch = {};
  if (search.project) next.project = search.project;
  if (value !== ALL_ENVIRONMENTS_VALUE) next.machine = value;
  return next;
}

/** Choosing a project keeps the environment axis. */
export function selectProjectAxis(search: SettingsScopeSearch, value: string): SettingsScopeSearch {
  const next: SettingsScopeSearch = {};
  if (value !== ALL_PROJECTS_VALUE) next.project = value;
  if (search.machine) next.machine = search.machine;
  return next;
}

export interface ProjectScopeMenuEntry<E extends ScopeEnvironment> {
  readonly group: SidebarProjectSnapshot;
  /** Where the shown checkouts live; empty when only one environment exists. */
  readonly environments: readonly E[];
}

/**
 * The project picker's rows, from groups already narrowed to any chosen
 * environment. Each row names its environments, so same-name projects read as
 * "Astrabit • Fedora" and "Astrabit • SwerveStation".
 */
export function projectScopeMenuEntries<E extends ScopeEnvironment>(
  groups: readonly SidebarProjectSnapshot[],
  environments: readonly E[],
): ProjectScopeMenuEntry<E>[] {
  return groups.map((group) => {
    const shownIds = new Set(group.memberProjects.map((member) => member.environmentId));
    return {
      group,
      environments:
        environments.length > 1
          ? environments.filter((environment) => shownIds.has(environment.environmentId))
          : [],
    };
  });
}

/** Provider configuration always belongs to one environment, including project scopes. */
export function selectSingleEnvironmentScope(
  search: SettingsScopeSearch,
  scope: ResolvedSettingsScope,
  environments: readonly {
    readonly environmentId: EnvironmentPresentation["environmentId"];
    readonly connection: Pick<EnvironmentPresentation["connection"], "phase">;
  }[],
  primaryEnvironmentId: string | null,
): SettingsScopeSearch {
  if (search.machine || scope.kind === "unavailable") return search;
  const selectedIds = new Set(scope.environmentIds);
  const candidates = environments.filter((environment) =>
    selectedIds.has(environment.environmentId),
  );
  const selected =
    candidates.find((environment) => environment.environmentId === primaryEnvironmentId) ??
    candidates.find((environment) => environment.connection.phase === "connected") ??
    candidates[0];
  return selected ? { ...search, machine: selected.environmentId } : search;
}

/**
 * The search Settings resolves and the project groups it resolves against.
 * `groups` are narrowed to the final search's machine, so labels,
 * representatives and members come from that environment only; `allGroups`
 * spans every environment.
 */
export function resolveSettingsScopeSearch(input: {
  readonly rawSearch: SettingsScopeSearch;
  readonly singleEnvironment: boolean;
  readonly environments: readonly (ScopeEnvironment & {
    readonly connection: Pick<EnvironmentPresentation["connection"], "phase">;
  })[];
  readonly primaryEnvironmentId: string | null;
  /** Project groups narrowed to `machine`, or every environment's when undefined. */
  readonly groupsFor: (machine: string | undefined) => readonly SidebarProjectSnapshot[];
}) {
  const { rawSearch, environments } = input;
  const allGroups = input.groupsFor(undefined);
  // Picking the provider page's machine reads every environment's groups; a
  // raw `machine` returns before they are used.
  const search = input.singleEnvironment
    ? selectSingleEnvironmentScope(
        rawSearch,
        resolveSettingsScope(rawSearch, allGroups, environments),
        environments,
        input.primaryEnvironmentId,
      )
    : rawSearch;
  const groups = search.machine === undefined ? allGroups : input.groupsFor(search.machine);
  return { search, groups, allGroups };
}

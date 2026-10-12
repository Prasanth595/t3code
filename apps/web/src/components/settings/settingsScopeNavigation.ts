import type { ResolvedEnvironmentSelection } from "@t3tools/client-runtime/state/environment-selection";
import type { SearchMiddleware } from "@tanstack/react-router";

import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";

/** Accept legacy provider links without replacing an explicit settings scope. */
export function validateSettingsRouteSearch(raw: Record<string, unknown>) {
  return validateSettingsScopeSearch(
    typeof raw.environmentId === "string" && raw.machine === undefined && raw.project === undefined
      ? { ...raw, machine: raw.environmentId }
      : raw,
  );
}

const SCOPE_KEYS = [
  "project",
  "machine",
  "checkout",
] as const satisfies readonly (keyof SettingsScopeSearch)[];
const TARGET_INPUT_KEYS = [...SCOPE_KEYS, "environmentId"];

/**
 * Category links keep the target, while an explicit target replaces the entire
 * previous selection. `environmentId` is the legacy provider deep-link target.
 */
export const retainSettingsScope: SearchMiddleware<SettingsScopeSearch> = ({ search, next }) => {
  const result = next(search);
  if (TARGET_INPUT_KEYS.some((key) => Object.hasOwn(result, key))) return result;
  const previousScope = Object.fromEntries(
    SCOPE_KEYS.filter((key) => search[key] !== undefined).map((key) => [key, search[key]]),
  );
  return { ...previousScope, ...result };
};

/**
 * Entering Settings starts on the environment the views are narrowed to. A link
 * that already names a machine or checkout keeps its own target, and choosing
 * "All environments" inside Settings is not overridden afterwards. Only an
 * active selection seeds: a missing, disabled or loading one never does.
 * `groups` must span every environment.
 */
export function seedSettingsMachine(
  search: SettingsScopeSearch,
  selection: ResolvedEnvironmentSelection,
  groups: readonly {
    readonly projectKey: string;
    readonly memberProjects: readonly { readonly environmentId: string }[];
  }[],
): SettingsScopeSearch | null {
  if (
    selection.status !== "active" ||
    search.machine !== undefined ||
    search.checkout !== undefined
  ) {
    return null;
  }
  // A project link opens on the environment only when the project has a checkout there.
  if (
    search.project !== undefined &&
    !groups.some(
      (group) =>
        group.projectKey === search.project &&
        group.memberProjects.some((member) => member.environmentId === selection.environmentId),
    )
  ) {
    return null;
  }
  return { ...search, machine: selection.environmentId };
}

import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings, type ProjectGroupingSettings } from "../../logicalProject";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useProjects } from "../../state/entities";
import type { Project } from "../../types";

/**
 * Settings uses the same logical projects as the sidebar, sorted by display
 * name. A `machine` narrows the projects before grouping, so group labels and
 * members only come from that environment. Unlike the view filter, it does not
 * judge whether the environment is enabled or online.
 */
export function buildSettingsProjectGroups(input: {
  readonly projects: readonly Project[];
  readonly settings: ProjectGroupingSettings;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environments: readonly Pick<EnvironmentPresentation, "environmentId" | "label">[];
  readonly machine: string | undefined;
}) {
  const { projects, settings, primaryEnvironmentId, environments, machine } = input;
  const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
  return buildSidebarProjectSnapshots({
    projects:
      machine === undefined
        ? projects
        : projects.filter((project) => project.environmentId === machine),
    settings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Builds Settings project groups for a machine, or every environment when undefined. */
export function useSettingsProjectGroupBuilder() {
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  return useCallback(
    (machine: string | undefined) =>
      buildSettingsProjectGroups({
        projects,
        settings,
        primaryEnvironmentId,
        environments,
        machine,
      }),
    [environments, primaryEnvironmentId, projects, settings],
  );
}

export function useSettingsProjectGroups() {
  const buildGroups = useSettingsProjectGroupBuilder();
  return useMemo(() => buildGroups(undefined), [buildGroups]);
}

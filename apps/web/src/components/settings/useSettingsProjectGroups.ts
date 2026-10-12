import {
  resolveEnvironmentSelection,
  selectProjectsForEnvironment,
} from "@t3tools/client-runtime/state/environment-selection";
import { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";

/**
 * Settings uses the same logical projects as the sidebar, sorted by display
 * name. A `machine` narrows the projects before grouping, so group labels and
 * members only come from that environment; a missing one yields no groups.
 */
export function useSettingsProjectGroups(machine?: string) {
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments, isReady } = useEnvironments();
  return useMemo(() => {
    const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
    const scopedProjects =
      machine === undefined
        ? projects
        : selectProjectsForEnvironment(
            projects,
            resolveEnvironmentSelection(
              { kind: "one", environmentId: EnvironmentId.make(machine) },
              environments.map((entry) => ({
                environmentId: entry.environmentId,
                enabled: entry.entry.enabled,
                online: entry.connection.phase === "connected",
              })),
              isReady,
            ),
          );
    return buildSidebarProjectSnapshots({
      projects: scopedProjects,
      settings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [environments, isReady, machine, primaryEnvironmentId, projects, settings]);
}

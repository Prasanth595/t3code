import type { EnvironmentId } from "@t3tools/contracts";
import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import { toggleSettingsEnvironment } from "./settings-environment-filter.logic";

export type SettingsTarget = EnvironmentPresentation & {
  readonly serverConfig: NonNullable<EnvironmentPresentation["serverConfig"]>;
};

function connectedSettingsTargets(environments: readonly EnvironmentPresentation[]) {
  return environments.filter(
    (entry): entry is SettingsTarget =>
      entry.connection.phase === "connected" && entry.serverConfig !== null,
  );
}

interface SettingsEnvironmentSelection {
  readonly selectedIds: ReadonlySet<EnvironmentId> | null;
  readonly selectedProjectKey: string | null;
  readonly setSelectedIds: Dispatch<SetStateAction<ReadonlySet<EnvironmentId> | null>>;
  readonly setSelectedProjectKey: Dispatch<SetStateAction<string | null>>;
}

const SettingsEnvironmentSelectionContext = createContext<SettingsEnvironmentSelection | null>(
  null,
);

/**
 * Holds the Settings scope selection across Settings pages, which are separate root routes.
 * It stays mounted for the whole app, so it keeps only the selection; the environment and
 * project data is derived in the hook, by the Settings pages that are mounted. The selection
 * resets when Settings closes.
 */
export function SettingsEnvironmentFilterProvider(props: {
  readonly open: boolean;
  readonly children: ReactNode;
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<EnvironmentId> | null>(null);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  if (!props.open && (selectedIds !== null || selectedProjectKey !== null)) {
    setSelectedIds(null);
    setSelectedProjectKey(null);
  }
  const value = useMemo(
    () => ({ selectedIds, selectedProjectKey, setSelectedIds, setSelectedProjectKey }),
    [selectedIds, selectedProjectKey],
  );
  return (
    <SettingsEnvironmentSelectionContext value={value}>
      {props.children}
    </SettingsEnvironmentSelectionContext>
  );
}

export function useSettingsEnvironmentFilter() {
  const selection = useContext(SettingsEnvironmentSelectionContext);
  if (selection === null) throw new Error("Settings environment filter provider is missing.");
  const { selectedIds, selectedProjectKey, setSelectedIds, setSelectedProjectKey } = selection;
  const { environments } = useEnvironments();
  const projects = useProjects();
  const groupingSettings = useMobileProjectGroupingSettings();
  const groupingMode = groupingSettings.sidebarProjectGroupingMode;
  const projectGroups = useMemo(
    () =>
      buildProjectGroups({
        projects,
        settings: { sidebarProjectGroupingMode: groupingMode, sidebarProjectGroupingOverrides: {} },
      }),
    [projects, groupingMode],
  );
  const availableTargets = useMemo(() => connectedSettingsTargets(environments), [environments]);
  const selectedTargets = useMemo(
    () =>
      availableTargets.filter(
        (entry) => selectedIds === null || selectedIds.has(entry.environmentId),
      ),
    [availableTargets, selectedIds],
  );
  const selectableProjectGroups = useMemo(
    () =>
      projectGroups.filter((group) =>
        group.members.some((member) =>
          selectedTargets.some((target) => target.environmentId === member.project.environmentId),
        ),
      ),
    [projectGroups, selectedTargets],
  );
  return useMemo(
    () => ({
      availableTargets,
      selectedTargets,
      selectedIds,
      projectGroups,
      selectableProjectGroups,
      selectedProjectKey,
      selectProject: setSelectedProjectKey,
      selectAll: () => setSelectedIds(null),
      toggleEnvironment: (environmentId: EnvironmentId) =>
        setSelectedIds((current) =>
          toggleSettingsEnvironment(current, availableTargets, environmentId),
        ),
    }),
    [
      availableTargets,
      selectedTargets,
      selectedIds,
      projectGroups,
      selectableProjectGroups,
      selectedProjectKey,
      setSelectedIds,
      setSelectedProjectKey,
    ],
  );
}

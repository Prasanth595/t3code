import { useAtomValue } from "@effect/atom-react";
import {
  resolveEnvironmentSelection,
  selectProjectsForEnvironment,
} from "@t3tools/client-runtime/state/environment-selection";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useUiStateStore } from "../uiStateStore";
import { useProjects } from "./entities";
import { environmentSummaries } from "./presentation";

/**
 * The device's environment filter, resolved against the catalog. Reads
 * connection summaries rather than presentations so provider and config
 * refreshes do not re-resolve it.
 */
export function useEnvironmentSelection() {
  const selection = useUiStateStore((store) => store.environmentSelection);
  const setSelection = useUiStateStore((store) => store.setEnvironmentSelection);
  const isReady = useAtomValue(environmentCatalog.catalogValueAtom).isReady;
  const summaries = useAtomValue(environmentSummaries.environmentsAtom);
  const resolved = useMemo(
    () =>
      resolveEnvironmentSelection(
        selection,
        summaries.map((summary) => ({
          environmentId: summary.environmentId,
          enabled: summary.isEnabled,
          online: summary.connectionState === "connected",
        })),
        isReady,
      ),
    [isReady, selection, summaries],
  );
  return { selection, resolved, setSelection };
}

/** Projects in the selected environment. Group these, never the full list. */
export function useSelectedEnvironmentProjects(): readonly EnvironmentProject[] {
  const projects = useProjects();
  const { resolved } = useEnvironmentSelection();
  return useMemo(() => selectProjectsForEnvironment(projects, resolved), [projects, resolved]);
}

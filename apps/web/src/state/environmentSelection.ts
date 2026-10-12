import { useAtomValue } from "@effect/atom-react";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import {
  ALL_ENVIRONMENTS_SELECTION,
  resolveEnvironmentSelection,
  selectProjectsForEnvironment,
  type EnvironmentSelection,
  type ResolvedEnvironmentSelection,
} from "@t3tools/client-runtime/state/environment-selection";
import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { useUiStateStore } from "../uiStateStore";
import { environmentProjects } from "./projects";
import { environmentSummaries } from "./presentation";

function resolvedSelectionsEqual(
  left: ResolvedEnvironmentSelection,
  right: ResolvedEnvironmentSelection,
): boolean {
  switch (left.status) {
    case "all":
      return (
        right.status === "all" && arrayElementsEqual(left.environmentIds, right.environmentIds)
      );
    case "active":
      return (
        right.status === "active" &&
        left.environmentId === right.environmentId &&
        left.online === right.online
      );
    case "pending":
    case "missing":
      return right.status === left.status && left.environmentId === right.environmentId;
  }
}

/**
 * The environment filter resolved against the catalog, and the projects it
 * shows, keyed by the selected environment (null for all). Every reader of one
 * selection shares a result that keeps its identity until it changes. Reads
 * connection summaries rather than presentations so provider and config
 * refreshes do not re-resolve it.
 */
export function createEnvironmentSelectionAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<{ readonly isReady: boolean }>;
  readonly environmentsAtom: Atom.Atom<
    ReadonlyArray<
      Pick<EnvironmentConnectionSummary, "environmentId" | "isEnabled" | "connectionState">
    >
  >;
  readonly projectsAtom: Atom.Atom<ReadonlyArray<EnvironmentProject>>;
}) {
  const resolvedAtom = Atom.family((environmentId: EnvironmentId | null) =>
    Atom.make((get): ResolvedEnvironmentSelection => {
      const next = resolveEnvironmentSelection(
        environmentId === null ? ALL_ENVIRONMENTS_SELECTION : { kind: "one", environmentId },
        get(input.environmentsAtom).map((summary) => ({
          environmentId: summary.environmentId,
          enabled: summary.isEnabled,
          online: summary.connectionState === "connected",
        })),
        get(input.catalogValueAtom).isReady,
      );
      const previous = Option.getOrNull(get.self<ResolvedEnvironmentSelection>());
      return previous !== null && resolvedSelectionsEqual(previous, next) ? previous : next;
    }).pipe(Atom.withLabel(`web-environment-selection:${environmentId ?? "all"}`)),
  );
  const projectsAtom = Atom.family((environmentId: EnvironmentId | null) =>
    Atom.make((get): ReadonlyArray<EnvironmentProject> => {
      const next = selectProjectsForEnvironment(
        get(input.projectsAtom),
        get(resolvedAtom(environmentId)),
      );
      const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentProject>>());
      return previous !== null && arrayElementsEqual(previous, next) ? previous : next;
    }).pipe(Atom.withLabel(`web-environment-selection-projects:${environmentId ?? "all"}`)),
  );
  return { resolvedAtom, projectsAtom };
}

export const environmentSelectionAtoms = createEnvironmentSelectionAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  environmentsAtom: environmentSummaries.environmentsAtom,
  projectsAtom: environmentProjects.projectsAtom,
});

const selectSelectedEnvironmentId = (store: {
  readonly environmentSelection: EnvironmentSelection;
}) => (store.environmentSelection.kind === "all" ? null : store.environmentSelection.environmentId);

/** The device's environment filter, resolved against the catalog. */
export function useEnvironmentSelection() {
  const selection = useUiStateStore((store) => store.environmentSelection);
  const setSelection = useUiStateStore((store) => store.setEnvironmentSelection);
  const environmentId = useUiStateStore(selectSelectedEnvironmentId);
  const resolved = useAtomValue(environmentSelectionAtoms.resolvedAtom(environmentId));
  return { selection, resolved, setSelection };
}

/** Projects in the selected environment. Group these, never the full list. */
export function useSelectedEnvironmentProjects(): readonly EnvironmentProject[] {
  const environmentId = useUiStateStore(selectSelectedEnvironmentId);
  return useAtomValue(environmentSelectionAtoms.projectsAtom(environmentId));
}

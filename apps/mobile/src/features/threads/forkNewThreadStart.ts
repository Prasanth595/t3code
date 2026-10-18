import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { MobileNewThreadProject } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useRef } from "react";

import { environmentServerConfigsAtom } from "../../state/server";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/**
 * Fork: `mobileNewThreadProject` from the first server that changed it from `picker`. The machine
 * map syncs it to every server, so they normally agree.
 */
const newThreadProjectAtom = Atom.make((get): MobileNewThreadProject => {
  for (const config of get(environmentServerConfigsAtom).values()) {
    if (config.settings.mobileNewThreadProject !== "picker") {
      return config.settings.mobileNewThreadProject;
    }
  }
  return "picker";
}).pipe(Atom.withLabel("mobile:fork-new-thread-project"));

/**
 * Fork: opens the draft that `mobileNewThreadProject` names, once, when the project picker opens
 * as the first screen of a new thread. The picker stays under the draft, so Back shows it.
 */
export function useForkNewThreadStart(input: {
  /** False when a share, a prompt link or the draft opened the picker: those keep the picker. */
  readonly enabled: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly canStartScratch: boolean;
  readonly startScratch: () => Promise<void>;
  readonly selectProject: (project: EnvironmentProject) => Promise<void>;
}): void {
  const mode = useAtomValue(newThreadProjectAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const last = AsyncResult.isSuccess(preferences) ? preferences.value.lastNewThreadProject : null;
  const ranRef = useRef(false);
  const { enabled, projects, canStartScratch, startScratch, selectProject } = input;

  useEffect(() => {
    if (ranRef.current || !enabled || mode === "picker") return;
    // Wait until the preferences load; a missing last project keeps the picker.
    if (!AsyncResult.isSuccess(preferences)) return;
    const scratch = mode === "none" || last?.scratch === true;
    if (scratch) {
      // Starting without a project needs a connected environment; wait for one.
      if (!canStartScratch) return;
      ranRef.current = true;
      void startScratch();
      return;
    }
    const project = last
      ? projects.find(
          (candidate) =>
            candidate.environmentId === last.environmentId && candidate.id === last.projectId,
        )
      : undefined;
    // The project can arrive with the environment snapshot. Until then, the picker shows.
    if (!project) return;
    ranRef.current = true;
    void selectProject(project);
  }, [canStartScratch, enabled, last, mode, preferences, projects, selectProject, startScratch]);
}

/** Fork: saves the project of a new thread, only while `mobileNewThreadProject` is `last`. */
export function useRememberNewThreadProject(): (
  project: EnvironmentProject,
  scratch: boolean,
) => void {
  const mode = useAtomValue(newThreadProjectAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  return useCallback(
    (project, scratch) => {
      if (mode !== "last") return;
      savePreferences({
        lastNewThreadProject: {
          environmentId: project.environmentId,
          projectId: project.id,
          scratch,
        },
      });
    },
    [mode, savePreferences],
  );
}

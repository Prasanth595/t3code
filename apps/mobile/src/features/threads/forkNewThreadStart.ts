import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { MobileNewThreadProject } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { environmentServerConfigsAtom } from "../../state/server";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/**
 * Fork: `mobileNewThreadProject` from the first server that changed it from `picker`. The machine
 * map syncs it to every server, so they normally agree. Null before any server config arrives.
 */
const liveNewThreadProjectAtom = Atom.make((get): MobileNewThreadProject | null => {
  const configs = [...get(environmentServerConfigsAtom).values()];
  if (configs.length === 0) return null;
  for (const config of configs) {
    if (config.settings.mobileNewThreadProject !== "picker") {
      return config.settings.mobileNewThreadProject;
    }
  }
  return "picker";
}).pipe(Atom.withLabel("mobile:fork-new-thread-project"));

/** The live value, else the value that the phone saw last, so a cold start does not wait. */
function useNewThreadProjectMode(): MobileNewThreadProject {
  const live = useAtomValue(liveNewThreadProjectAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const stored = AsyncResult.isSuccess(preferences)
    ? preferences.value.newThreadProjectMode
    : undefined;
  useEffect(() => {
    if (live !== null && AsyncResult.isSuccess(preferences) && live !== stored) {
      savePreferences({ newThreadProjectMode: live });
    }
  }, [live, preferences, savePreferences, stored]);
  return live ?? stored ?? "picker";
}

/**
 * Fork: opens the draft that `mobileNewThreadProject` names, once, when the project picker opens
 * as the first screen of a new thread. The picker stays under the draft, so Back shows it.
 *
 * The draft opens before the first paint when its project is in the local project list, also
 * before a server connects: the last project, or the project of the last thread without a
 * project. Only the first thread without a project waits for the server to make that project.
 */
export function useForkNewThreadStart(input: {
  /** False when a share, a prompt link or the draft opened the picker: those keep the picker. */
  readonly enabled: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly canStartScratch: boolean;
  readonly startScratch: () => Promise<void>;
  readonly selectProject: (project: EnvironmentProject) => Promise<void>;
}): void {
  const mode = useNewThreadProjectMode();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const last = AsyncResult.isSuccess(preferences) ? preferences.value.lastNewThreadProject : null;
  const rememberedScratch = AsyncResult.isSuccess(preferences)
    ? preferences.value.scratchProject
    : undefined;
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const ranRef = useRef(false);
  const { enabled, projects, canStartScratch, startScratch, selectProject } = input;

  // A layout effect, so a known project opens before the picker paints.
  useLayoutEffect(() => {
    if (ranRef.current || !enabled || mode === "picker") return;
    // Wait until the preferences load; a missing last project keeps the picker.
    if (!AsyncResult.isSuccess(preferences)) return;
    const scratch = mode === "none" || last?.scratch === true;
    if (scratch) {
      const known =
        (rememberedScratch
          ? projects.find(
              (candidate) =>
                candidate.environmentId === rememberedScratch.environmentId &&
                candidate.id === rememberedScratch.projectId,
            )
          : undefined) ??
        projects.find((candidate) =>
          isScratchProject(
            candidate,
            serverConfigs.get(candidate.environmentId)?.scratchWorkspaceRoot,
          ),
        );
      if (known) {
        ranRef.current = true;
        void selectProject(known);
        return;
      }
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
  }, [
    canStartScratch,
    enabled,
    last,
    mode,
    preferences,
    projects,
    rememberedScratch,
    selectProject,
    serverConfigs,
    startScratch,
  ]);
}

/**
 * Fork: saves the project of a new thread while `mobileNewThreadProject` is `last`, and the
 * project of every thread without a project, so the next one opens without the server.
 */
export function useRememberNewThreadProject(): (
  project: EnvironmentProject,
  scratch: boolean,
) => void {
  const mode = useNewThreadProjectMode();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  return useCallback(
    (project, scratch) => {
      if (scratch) {
        savePreferences({
          scratchProject: { environmentId: project.environmentId, projectId: project.id },
        });
      }
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

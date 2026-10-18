/**
 * Fork: the sidebar groups on mobile. The groups are the server setting `sidebarGroups`, and the
 * machine map syncs them, like on web (useSidebarGroups.ts). The app shows them while a connected
 * server has `mobileSidebarGroups` on.
 */
import {
  createSidebarGroup,
  pruneSidebarGroupAssignments,
} from "@t3tools/client-runtime/state/sidebarGroups";
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  WS_METHODS,
  type EnvironmentId,
  type SidebarGroups,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { Atom } from "effect/reactivity";

import * as Dialog from "../components/ui/Dialog";
import { connectionAtomRuntime } from "../connection/runtime";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { readEnvironmentScope } from "./session";
import { environmentThreadShells } from "./threads";

let previousGroups: SidebarGroups | null = null;

/**
 * The groups while a connected server has `mobileSidebarGroups` on, else null. They come from the
 * first such server with a group, else the first such server. The previous value stays while the
 * groups are equal, so a config snapshot that does not change them renders nothing.
 */
export const sidebarGroupsAtom = Atom.make((get): SidebarGroups | null => {
  const enabled = [...get(environmentServerConfigsAtom).values()].filter(
    (config) => config.settings.mobileSidebarGroups,
  );
  const next = (
    enabled.find((config) => config.settings.sidebarGroups.groups.length > 0) ?? enabled[0]
  )?.settings.sidebarGroups;
  if (next === undefined) return null;
  if (previousGroups !== null && Equal.equals(previousGroups, next)) return previousGroups;
  previousGroups = next;
  return next;
}).pipe(Atom.withLabel("mobile:fork-sidebar-groups"));

/** The group that the group editor shows, or `default` for the first tab. */
export const editedSidebarGroupIdAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:fork-sidebar-group-edited"),
);

const shareMachineMapSettings = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:machine-map:share-settings",
  tag: WS_METHODS.machineMapShareSettings,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

// Each write replaces the groups whole. Two quick edits chain through this value, so the second
// does not undo the first before the server echoes it.
let pendingGroups: SidebarGroups | null = null;

/**
 * Saves a change of the groups on each connected server with `mobileSidebarGroups` on, then
 * shares it through the machine map, so the other machines get it too. A server without the
 * settings write permission keeps its groups.
 */
export function editSidebarGroups(change: (current: SidebarGroups) => SidebarGroups): void {
  const saved = appAtomRegistry.get(sidebarGroupsAtom);
  const targets: EnvironmentId[] = [];
  for (const [environmentId, config] of appAtomRegistry.get(environmentServerConfigsAtom)) {
    if (
      config.settings.mobileSidebarGroups &&
      readEnvironmentScope(environmentId, AuthSettingsWriteScope)
    ) {
      targets.push(environmentId);
    }
  }
  if (saved === null || targets.length === 0) {
    Dialog.alert("Groups not saved", "No connected environment lets this phone change settings.");
    return;
  }
  const current = pendingGroups ?? saved;
  const liveThreads = appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .filter((thread) => thread.archivedAt === null);
  const next = pruneSidebarGroupAssignments(change(current), liveThreads);
  if (Equal.equals(next, current)) return;
  pendingGroups = next;
  void Promise.all(
    targets.map((environmentId) =>
      runAtomCommand(
        appAtomRegistry,
        serverEnvironment.updateSettings,
        { environmentId, input: { patch: { sidebarGroups: next } } },
        { label: "sidebar groups update", reportFailure: false },
      ).then((result) => ({ environmentId, result })),
    ),
  ).then((writes) => {
    if (pendingGroups === next) pendingGroups = null;
    const shared = writes.find((write) => write.result._tag === "Success");
    if (shared !== undefined) {
      void runAtomCommand(
        appAtomRegistry,
        shareMachineMapSettings,
        { environmentId: shared.environmentId, input: { server: ["sidebarGroups"], client: {} } },
        { reportFailure: false },
      );
    }
    const failed = writes.find(
      (write) => write.result._tag === "Failure" && !isAtomCommandInterrupted(write.result),
    );
    if (failed === undefined || failed.result._tag !== "Failure") return;
    const error = squashAtomCommandFailure(failed.result);
    Dialog.alert(
      "Groups not saved",
      error instanceof Error ? error.message : "Try reconnecting and saving again.",
    );
  });
}

/** Makes a group and returns its id. The caller moves threads into it or opens its editor. */
export function createMobileSidebarGroup(
  change: (settings: SidebarGroups, id: string) => SidebarGroups = (settings) => settings,
): string {
  const id = uuidv4();
  editSidebarGroups((current) => change(createSidebarGroup(current, id), id));
  return id;
}

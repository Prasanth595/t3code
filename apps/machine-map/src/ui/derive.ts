/**
 * Queue facts that the page derives from the snapshot (MM-602, MM-604). The page has the newest
 * revisions only (the snapshot holds 100), so a machine that missed more shows at most that many.
 */
import type {
  MachineCommand,
  MachineId,
  MachineMapDocument,
  MachineRecord,
  MapChange,
  MapRevision,
  PortalSnapshot,
} from "@t3tools/contracts/machineMap";

import type { PendingRotation } from "../api.ts";
import { findMachine } from "../rules/map.ts";
import { pendingRevisions } from "../rules/queue.ts";
import { LEVEL_LABEL, machineName, shortTime, valueText } from "./format.ts";

export interface MachineQueue {
  readonly revisions: ReadonlyArray<MapRevision>;
  readonly commands: ReadonlyArray<MachineCommand>;
  readonly rotation: PendingRotation | undefined;
  readonly count: number;
}

export function machineQueue(
  snapshot: PortalSnapshot,
  rotations: ReadonlyArray<PendingRotation>,
  machine: MachineRecord,
): MachineQueue {
  const machineId = machine.id;
  const presence = snapshot.presence[machineId];
  const revisions = pendingRevisions(snapshot.history, machine, presence?.appliedRevision ?? null);
  const commands = snapshot.commands.filter(
    (c) => c.machineId === machineId && c.status === "queued",
  );
  const rotation = rotations.find((r) => r.machineId === machineId);
  return {
    revisions,
    commands,
    rotation,
    count: revisions.length + commands.length + (rotation ? 1 : 0),
  };
}

/** The newest revision that changed the arrow, or null when it is older than the loaded history. */
function lastArrowRevision(
  history: ReadonlyArray<MapRevision>,
  from: MachineId,
  to: MachineId,
): number | null {
  for (const revision of history) {
    const touched = revision.changes.some(
      (c) =>
        (c._tag === "setArrow" && c.arrow.from === from && c.arrow.to === to) ||
        (c._tag === "putMachine" && (c.machine.id === from || c.machine.id === to)),
    );
    if (touched) return revision.revision;
  }
  return null;
}

/** MM-604: for each end of the arrow, whether that machine applied its current state. */
export function arrowApplied(
  snapshot: PortalSnapshot,
  from: MachineId,
  to: MachineId,
): { readonly from: boolean; readonly to: boolean } {
  const revision = lastArrowRevision(snapshot.history, from, to);
  const applied = (id: MachineId) =>
    revision === null || (snapshot.presence[id]?.appliedRevision ?? -1) >= revision;
  return { from: applied(from), to: applied(to) };
}

/** One line for a change in history, proposals and drafts. */
export function describeChange(change: MapChange, map: MachineMapDocument): string {
  const name = (id: string) => machineName(map, id);
  switch (change._tag) {
    case "setArrow": {
      const a = change.arrow;
      const parts = [`${name(a.from)} → ${name(a.to)}: ${LEVEL_LABEL[a.level]}`];
      if (a.agentTools) parts.push("with agent tools");
      if (a.expiresAt && a.revertLevel)
        parts.push(`until ${shortTime(a.expiresAt)}, then ${LEVEL_LABEL[a.revertLevel]}`);
      return parts.join(", ");
    }
    case "setSetting": {
      const target = change.machineId === null ? "shared" : name(change.machineId);
      return change.present
        ? `${change.scope}.${change.key} = ${valueText(change.value)} (${target})`
        : `${change.scope}.${change.key} cleared (${target})`;
    }
    case "manageSetting":
      return change.managed
        ? `Manage ${change.scope}.${change.key}`
        : `Stop managing ${change.scope}.${change.key}`;
    case "putMachine": {
      const m = change.machine;
      const before = findMachine(map, m.id);
      return before
        ? `${m.name}: ${m.kind}, map role ${m.mapRole}`
        : `Machine ${m.name} (${m.kind})`;
    }
    case "removeMachine":
      return `Remove ${name(change.machineId)}`;
    case "putPreset":
      return `Preset ${change.preset.name} with ${change.preset.arrows.length} arrows`;
    case "removePreset":
      return `Delete preset ${change.name}`;
  }
}

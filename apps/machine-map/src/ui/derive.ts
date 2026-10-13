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
import { usesText } from "../rules/access.ts";
import { changesPublicFacts, findMachine, findNote } from "../rules/map.ts";
import { lockdownChanges } from "../rules/presets.ts";
import { pendingRevisions } from "../rules/queue.ts";
import { hasJoined, LEVEL_LABEL, machineName, shortTime, valueText } from "./format.ts";

export interface MachineQueue {
  readonly revisions: ReadonlyArray<MapRevision>;
  readonly commands: ReadonlyArray<MachineCommand>;
  readonly rotation: PendingRotation | undefined;
  /** MM-602: the machine never connected. Its work waits for it to join and is not counted. */
  readonly waitingToJoin: boolean;
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
  const waitingToJoin = !hasJoined(presence);
  return {
    revisions,
    commands,
    rotation,
    waitingToJoin,
    count: waitingToJoin ? 0 : revisions.length + commands.length + (rotation ? 1 : 0),
  };
}

/**
 * The newest revision that changed the arrow, or null when it is older than the loaded history.
 * A move or a map role change of an end does not change the arrow.
 */
function lastArrowRevision(
  history: ReadonlyArray<MapRevision>,
  from: MachineId,
  to: MachineId,
): number | null {
  for (const revision of history) {
    const touched = revision.changes.some(
      (c) =>
        (c._tag === "setArrow" && c.arrow.from === from && c.arrow.to === to) ||
        (c._tag === "putMachine" &&
          (c.machine.id === from || c.machine.id === to) &&
          changesPublicFacts(revision, c.machine)),
    );
    if (touched) return revision.revision;
  }
  return null;
}

/** MM-602: a machine that never connected waits to join. Its work is not queued. */
export type ArrowEnd = "applied" | "queued" | "waitingToJoin";

/** MM-604: for each end of the arrow, whether that machine applied its current state. */
export function arrowEnds(
  snapshot: PortalSnapshot,
  from: MachineId,
  to: MachineId,
): { readonly from: ArrowEnd; readonly to: ArrowEnd } {
  const revision = lastArrowRevision(snapshot.history, from, to);
  const end = (id: MachineId): ArrowEnd => {
    const presence = snapshot.presence[id];
    if (revision === null || (presence?.appliedRevision ?? -1) >= revision) return "applied";
    return hasJoined(presence) ? "queued" : "waitingToJoin";
  };
  return { from: end(from), to: end(to) };
}

/** The wait of one arrow end in words, or null when it applied the arrow. */
export function arrowEndWait(end: ArrowEnd, machine: MachineRecord): string | null {
  switch (end) {
    case "applied":
      return null;
    case "queued":
      return `queued for ${machine.name}`;
    case "waitingToJoin":
      return `waiting for ${machine.name} to join`;
  }
}

/** One line for a change in history, proposals and drafts. */
export function describeChange(change: MapChange, map: MachineMapDocument): string {
  const name = (id: string) => machineName(map, id);
  switch (change._tag) {
    case "setArrow": {
      const a = change.arrow;
      const parts = [`${usesText(name(a.from), name(a.to))}: ${LEVEL_LABEL[a.level]}`];
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
    case "placePair":
      return change.offset
        ? `Card of ${name(change.a)} and ${name(change.b)} moved`
        : `Card of ${name(change.a)} and ${name(change.b)} back to its own place`;
    case "putNote":
      return `Note ${noteQuote(change.note.text)}`;
    case "removeNote": {
      const note = findNote(map, change.id);
      return note ? `Delete note ${noteQuote(note.text)}` : "Delete a note";
    }
  }
}

/** The start of a note in quotes, for one-line texts. */
export function noteQuote(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return `“${line.length > 32 ? `${line.slice(0, 31)}…` : line}”`;
}

/** MM-708: what one press of the big red button reaches now. */
export interface PauseReach {
  /** MM-709: every machine gets "stop all agents". */
  readonly machines: number;
  /** Offline machines stop their agents when they connect again. */
  readonly offline: number;
  /** MM-710: the arrows and map roles that become `none`. */
  readonly arrows: number;
  readonly mapRoles: number;
}

/** Uses the lockdown rule of the pause on the live map without the draft, like the server. */
export function pauseReach(snapshot: PortalSnapshot): PauseReach {
  const machines = snapshot.map.machines;
  const changes = lockdownChanges(snapshot.map);
  return {
    machines: machines.length,
    offline: machines.filter((machine) => snapshot.presence[machine.id]?.online !== true).length,
    arrows: changes.filter((change) => change._tag === "setArrow").length,
    mapRoles: changes.filter((change) => change._tag === "putMachine").length,
  };
}

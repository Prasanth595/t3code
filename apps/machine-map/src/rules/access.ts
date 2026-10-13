/**
 * Pure rules for arrows and for agent writes: build an arrow change (MM-304), the map role that a
 * tool needs (MM-802) and the self-escalation check (MM-803).
 */
import type {
  ArrowRecord,
  MachineId,
  MachineLevel,
  MachineMapDocument,
  MapChange,
  MapToolName,
} from "@t3tools/contracts/machineMap";

import { applyChanges, findArrow, findMachine, levelRank, roleRank } from "./map.ts";

export interface ArrowInput {
  readonly from: MachineId;
  readonly to: MachineId;
  readonly level: MachineLevel;
  /** Omit to keep the current value. */
  readonly agentTools?: boolean;
  /** Null makes the level permanent. */
  readonly expiresAt: string | null;
}

/**
 * MM-304: a temporary level returns to the permanent level at expiry. A second temporary change
 * keeps the first permanent level, so a temporary grant never leaves permanent access behind.
 */
export function arrowChange(map: MachineMapDocument, input: ArrowInput): MapChange {
  const current = findArrow(map, input.from, input.to);
  const permanentLevel = current.revertLevel ?? current.level;
  const arrow: ArrowRecord = {
    from: input.from,
    to: input.to,
    level: input.level,
    agentTools: input.agentTools ?? current.agentTools,
    expiresAt: input.expiresAt,
    revertLevel: input.expiresAt === null ? null : permanentLevel,
  };
  return { _tag: "setArrow", arrow };
}

const permanentLevel = (arrow: ArrowRecord): MachineLevel => arrow.revertLevel ?? arrow.level;

/** True when `next` gives the source machine more access than `previous`, now or later. */
export function arrowRaises(previous: ArrowRecord, next: ArrowRecord): boolean {
  if (levelRank(next.level) > levelRank(previous.level)) return true;
  if (next.agentTools && !previous.agentTools) return true;
  if (levelRank(permanentLevel(next)) > levelRank(permanentLevel(previous))) return true;
  // A longer temporary grant above the permanent level is also more access.
  if (next.expiresAt !== null && levelRank(next.level) > levelRank(permanentLevel(previous))) {
    return (
      previous.expiresAt === null || Date.parse(next.expiresAt) > Date.parse(previous.expiresAt)
    );
  }
  return false;
}

/**
 * MM-803: true when the changes raise access for `machineId`: a higher level or agent tools on an
 * arrow from it, or a higher map role for it.
 */
export function raisesOwnAccess(
  map: MachineMapDocument,
  machineId: MachineId,
  changes: ReadonlyArray<MapChange>,
): boolean {
  let current = map;
  for (const change of changes) {
    if (change._tag === "setArrow" && change.arrow.from === machineId) {
      if (arrowRaises(findArrow(current, change.arrow.from, change.arrow.to), change.arrow)) {
        return true;
      }
    }
    if (change._tag === "putMachine" && change.machine.id === machineId) {
      const previousRole = findMachine(current, machineId)?.mapRole ?? "none";
      if (roleRank(change.machine.mapRole) > roleRank(previousRole)) return true;
    }
    current = applyChanges(current, [change]).map;
  }
  return false;
}

/** MM-802. Commands are not map changes, so a proposal cannot hold them: they need `edit`. */
export const requiredRole = (tool: MapToolName): "read" | "propose" | "edit" => {
  switch (tool) {
    case "machines_read":
      return "read";
    case "machines_command":
    case "machines_queue_cancel":
      return "edit";
    case "machines_set_access":
    case "machines_set_setting":
    case "machines_undo":
    case "machines_preset":
      return "propose";
  }
};

export type ToolGate =
  | { readonly _tag: "refuse"; readonly error: string }
  | { readonly _tag: "allow" };

/** MM-805, MM-1203: the portal checks the map role of the calling machine on every call. */
export function gateTool(
  map: MachineMapDocument,
  machineId: MachineId,
  tool: MapToolName,
): ToolGate {
  const machine = findMachine(map, machineId);
  if (!machine) return { _tag: "refuse", error: "This machine is not on the map." };
  const needed = requiredRole(tool);
  if (roleRank(machine.mapRole) >= roleRank(needed)) return { _tag: "allow" };
  return {
    _tag: "refuse",
    error: `${tool} needs the map role "${needed}". ${machine.name} has "${machine.mapRole}".`,
  };
}

export type WriteDecision =
  | { readonly _tag: "apply" }
  | { readonly _tag: "propose"; readonly reason: "map-role" | "self-escalation" };

/** MM-802, MM-803: decides whether agent changes apply at once or wait for the owner. */
export function decideAgentWrite(
  map: MachineMapDocument,
  machineId: MachineId,
  changes: ReadonlyArray<MapChange>,
): WriteDecision {
  if (raisesOwnAccess(map, machineId, changes))
    return { _tag: "propose", reason: "self-escalation" };
  const role = findMachine(map, machineId)?.mapRole ?? "none";
  return role === "edit" ? { _tag: "apply" } : { _tag: "propose", reason: "map-role" };
}

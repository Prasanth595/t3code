/**
 * Pure rules for arrows and for agent writes: build an arrow change (MM-304), the map role that a
 * tool needs (MM-802) and the self-escalation check (MM-803).
 */
import type {
  ArrowRecord,
  ClientArrowRecord,
  ClientId,
  MachineId,
  MachineLevel,
  MachineMapDocument,
  MapChange,
  MapToolName,
} from "@t3tools/contracts/machineMap";

import {
  applyChanges,
  findArrow,
  findClient,
  findClientArrow,
  findMachine,
  levelRank,
  roleRank,
} from "./map.ts";

/** MM-1103: the one wording of an arrow everywhere: the source first, then the target. */
export const usesText = (from: string, to: string): string => `${from} uses ${to}`;

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

interface ClientArrowInput {
  readonly client: ClientId;
  readonly to: MachineId;
  readonly level: MachineLevel;
  /** Null makes the level permanent. */
  readonly expiresAt: string | null;
}

/** MM-309, MM-304: a client arrow keeps its first permanent level like a machine arrow. */
export function clientArrowChange(map: MachineMapDocument, input: ClientArrowInput): MapChange {
  const current = findClientArrow(map, input.client, input.to);
  return {
    _tag: "setClientArrow",
    arrow: {
      client: input.client,
      to: input.to,
      level: input.level,
      expiresAt: input.expiresAt,
      revertLevel: input.expiresAt === null ? null : (current.revertLevel ?? current.level),
    },
  };
}

type Leveled = Pick<ArrowRecord, "level" | "expiresAt" | "revertLevel">;

const permanentLevel = (arrow: Leveled): MachineLevel => arrow.revertLevel ?? arrow.level;

/** True when `next` gives the source more access than `previous`, now or later. */
function levelRaises(previous: Leveled, next: Leveled): boolean {
  if (levelRank(next.level) > levelRank(previous.level)) return true;
  if (levelRank(permanentLevel(next)) > levelRank(permanentLevel(previous))) return true;
  // A longer temporary grant above the permanent level is also more access.
  if (next.expiresAt !== null && levelRank(next.level) > levelRank(permanentLevel(previous))) {
    return (
      previous.expiresAt === null || Date.parse(next.expiresAt) > Date.parse(previous.expiresAt)
    );
  }
  return false;
}

/** True when `next` gives the source machine more access than `previous`, now or later. */
export const arrowRaises = (previous: ArrowRecord, next: ArrowRecord): boolean =>
  levelRaises(previous, next) || (next.agentTools && !previous.agentTools);

/** True when `next` gives the client more access than `previous`, now or later. */
export const clientArrowRaises = (previous: ClientArrowRecord, next: ClientArrowRecord): boolean =>
  levelRaises(previous, next);

/** True when a client change gives more access: a higher arrow, a new key or a new app token. */
function clientRaises(map: MachineMapDocument, change: MapChange): boolean {
  if (change._tag === "setClientArrow") {
    return clientArrowRaises(
      findClientArrow(map, change.arrow.client, change.arrow.to),
      change.arrow,
    );
  }
  if (change._tag === "addClientKey")
    return map.clientArrows.some((arrow) => arrow.client === change.clientId);
  // A new client has no arrows yet; its arrows count as their own changes.
  if (change._tag !== "putClient") return false;
  const previous = findClient(map, change.client.id);
  const newToken =
    change.client.serviceToken !== null &&
    change.client.serviceToken.clientId !== previous?.serviceToken?.clientId;
  return newToken && map.clientArrows.some((arrow) => arrow.client === change.client.id);
}

/** MM-807: client changes that only the owner makes. */
export const touchesClients = (changes: ReadonlyArray<MapChange>): boolean =>
  changes.some(
    (change) =>
      change._tag === "putClient" ||
      change._tag === "removeClient" ||
      change._tag === "addClientKey" ||
      change._tag === "removeClientKey" ||
      change._tag === "setClientArrow",
  );

/**
 * True when the changes raise access for a machine that `concerns` picks: a higher level or agent
 * tools on an arrow from it, or a higher map role for it.
 */
function raises(
  map: MachineMapDocument,
  changes: ReadonlyArray<MapChange>,
  concerns: (machineId: MachineId) => boolean,
): boolean {
  let current = map;
  for (const change of changes) {
    if (change._tag === "setArrow" && concerns(change.arrow.from)) {
      if (arrowRaises(findArrow(current, change.arrow.from, change.arrow.to), change.arrow)) {
        return true;
      }
    }
    if (change._tag === "putMachine" && concerns(change.machine.id)) {
      const previousRole = findMachine(current, change.machine.id)?.mapRole ?? "none";
      if (roleRank(change.machine.mapRole) > roleRank(previousRole)) return true;
    }
    current = applyChanges(current, [change]).map;
  }
  return false;
}

/** MM-803: true when the changes raise access for `machineId`. */
export const raisesOwnAccess = (
  map: MachineMapDocument,
  machineId: MachineId,
  changes: ReadonlyArray<MapChange>,
): boolean => raises(map, changes, (id) => id === machineId);

/** MM-711: true when the changes raise an arrow or a map role of any machine, or any client. */
export function raisesAnyAccess(
  map: MachineMapDocument,
  changes: ReadonlyArray<MapChange>,
): boolean {
  if (raises(map, changes, () => true)) return true;
  let current = map;
  for (const change of changes) {
    if (clientRaises(current, change)) return true;
    current = applyChanges(current, [change]).map;
  }
  return false;
}

/** MM-802. Commands are not map changes, so a proposal cannot hold them: they need `edit`. */
export const requiredRole = (tool: MapToolName): "read" | "propose" | "edit" => {
  switch (tool) {
    case "machines_read":
    case "machines_resources":
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

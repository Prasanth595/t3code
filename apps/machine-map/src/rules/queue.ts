/**
 * Pure rules for the queue (MM-6xx): command delivery, expiry, and what waits for each machine.
 */
import {
  isMachineLocalSetting,
  type MachineCommand,
  type MachineCommandKind,
  type MachineId,
  type MachineMapDocument,
  type MachinePresence,
  type MachineRecord,
  type MachineStatus,
  type MapChange,
  type MapRevision,
  type SettingScope,
  type SettingValues,
} from "@t3tools/contracts/machineMap";

import { effectiveSettings, sameValue, touches } from "./map.ts";

/** MM-605: the default expiry of a queued command. */
export const DEFAULT_COMMAND_MINUTES = 24 * 60;
/** MM-804. */
export const PROPOSAL_MINUTES = 24 * 60;
/** MM-202. */
export const JOIN_CODE_MINUTES = 10;
/** MM-207: a rotation waits like a queued command. */
export const ROTATION_MINUTES = DEFAULT_COMMAND_MINUTES;

export const addMinutes = (now: number, minutes: number): string =>
  new Date(now + minutes * 60_000).toISOString();

export const isDue = (time: string, now: number): boolean => Date.parse(time) <= now;

/** MM-605: "online" needs a connection. "idle" also needs no running turn. */
export function canDeliver(command: MachineCommand, presence: MachinePresence): boolean {
  if (command.status !== "queued" || !presence.online) return false;
  if (command.delivery === "online") return true;
  return presence.status !== null && presence.status.runningTurns === 0;
}

/** MM-502: a machine runs only the commands that it reports. Unknown support means no. */
export const supportsCommand = (status: MachineStatus | null, kind: MachineCommandKind): boolean =>
  status !== null && status.commands.includes(kind);

/** The earliest of the times, in epoch milliseconds, or null for none. */
export function earliest(times: Iterable<string>): number | null {
  let result: number | null = null;
  for (const time of times) {
    const at = Date.parse(time);
    if (Number.isNaN(at)) throw new Error(`Invalid time ${time}.`);
    if (result === null || at < result) result = at;
  }
  return result;
}

/**
 * MM-602, MM-603: revisions after the applied revision that change the desired state of a machine.
 * Revisions from before the machine joined the map do not count.
 */
export function pendingRevisions(
  history: ReadonlyArray<MapRevision>,
  machine: Pick<MachineRecord, "id" | "createdAt">,
  appliedRevision: number | null,
): Array<MapRevision> {
  const joined = Date.parse(machine.createdAt);
  return history.filter(
    (revision) =>
      revision.revision > (appliedRevision ?? 0) &&
      Date.parse(revision.at) >= joined &&
      touches(revision, machine.id),
  );
}

/**
 * MM-404: a change on a machine becomes an override of that machine when the setting has a
 * shared value or an override. A value equal to the shared value clears the override. A setting
 * without either stays local: the map only shows it (MM-406).
 */
export function localSettingChanges(
  map: MachineMapDocument,
  machineId: MachineId,
  scope: SettingScope,
  values: SettingValues,
): Array<MapChange> {
  const changes: Array<MapChange> = [];
  const desired = effectiveSettings(map, machineId)[scope];
  const shared = map.settings.shared[scope];
  const own = map.settings.overrides[machineId]?.[scope] ?? {};
  for (const [key, value] of Object.entries(values)) {
    if (isMachineLocalSetting(scope, key) || value === undefined) continue;
    if (!Object.hasOwn(shared, key) && !Object.hasOwn(own, key)) continue;
    if (Object.hasOwn(desired, key) && sameValue(desired[key], value)) continue;
    const matchesShared = Object.hasOwn(shared, key) && sameValue(shared[key], value);
    if (matchesShared && Object.hasOwn(own, key)) {
      changes.push({ _tag: "setSetting", machineId, scope, key, present: false, value: null });
    } else if (!matchesShared) {
      changes.push({ _tag: "setSetting", machineId, scope, key, present: true, value });
    }
  }
  return changes;
}

/**
 * MM-411: a change saved in T3 Settings for all environments becomes the shared value. Overrides
 * equal to the new value go: those machines took the same bulk edit. Other overrides stay.
 */
export function sharedSettingChanges(
  map: MachineMapDocument,
  scope: SettingScope,
  values: SettingValues,
): Array<MapChange> {
  const changes: Array<MapChange> = [];
  const shared = map.settings.shared[scope];
  for (const [key, value] of Object.entries(values)) {
    if (isMachineLocalSetting(scope, key) || value === undefined) continue;
    if (!Object.hasOwn(shared, key) || !sameValue(shared[key], value)) {
      changes.push({ _tag: "setSetting", machineId: null, scope, key, present: true, value });
    }
    for (const [id, own] of Object.entries(map.settings.overrides)) {
      if (Object.hasOwn(own[scope], key) && sameValue(own[scope][key], value)) {
        changes.push({
          _tag: "setSetting",
          machineId: id as MachineId,
          scope,
          key,
          present: false,
          value: null,
        });
      }
    }
  }
  return changes;
}

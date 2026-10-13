/**
 * Pure rules for the queue (MM-6xx): command delivery, expiry, and what waits for each machine.
 */
import type {
  MachineCommand,
  MachineCommandKind,
  MachineId,
  MachineMapDocument,
  MachinePresence,
  MachineRecord,
  MachineStatus,
  MapChange,
  MapRevision,
  SettingScope,
  SettingValues,
} from "@t3tools/contracts/machineMap";

import { effectiveSettings, isManaged, touches } from "./map.ts";

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

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * MM-404: settings changed on a machine become overrides of that machine. A value equal to the
 * shared value clears the override. Settings that the map does not manage stay local.
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
    if (!isManaged(map, scope, key) || value === undefined) continue;
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

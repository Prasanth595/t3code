/**
 * Pure rules for presets (MM-705), lockdown (MM-706), restore (MM-704) and the emergency pause
 * (MM-710, MM-712). Each returns map changes, so the result is one revision that can be undone.
 */
import * as Schema from "effect/Schema";
import {
  ArrowRecord,
  MachineMapRole,
  type MachineId,
  type MachineMapDocument,
  type MapChange,
  type MapPreset,
  type SettingScope,
} from "@t3tools/contracts/machineMap";

import {
  defaultArrow,
  findArrow,
  findMachine,
  findNote,
  isManaged,
  pairOffset,
  sameArrow,
} from "./map.ts";

/** Summaries that the portal writes itself. The history reads them to tell what a revision did. */
export const LOCKDOWN_SUMMARY = "Lockdown";
export const PAUSE_SUMMARY = "Emergency pause";
export const RESUME_SUMMARY = "Resume after emergency pause";

const permanent = (arrow: ArrowRecord): ArrowRecord => ({
  ...arrow,
  level: arrow.revertLevel ?? arrow.level,
  expiresAt: null,
  revertLevel: null,
});

/** A preset stores the permanent level of each arrow. A temporary level is not part of it. */
export const savePresetChange = (map: MachineMapDocument, name: string, at: string): MapChange => ({
  _tag: "putPreset",
  preset: {
    name,
    createdAt: at,
    arrows: map.arrows.map(permanent).filter((arrow) => arrow.level !== "none" || arrow.agentTools),
  },
});

/** Sets every arrow between current machines to `target`, and only the arrows that differ. */
function arrowChanges(
  map: MachineMapDocument,
  target: (from: MachineId, to: MachineId) => ArrowRecord,
): Array<MapChange> {
  const changes: Array<MapChange> = [];
  for (const from of map.machines) {
    for (const to of map.machines) {
      if (from.id === to.id) continue;
      const next = target(from.id, to.id);
      if (!sameArrow(findArrow(map, from.id, to.id), next)) {
        changes.push({ _tag: "setArrow", arrow: next });
      }
    }
  }
  return changes;
}

/** The arrows of a preset. Machines that left the map since the save are skipped. */
export function applyPresetChanges(map: MachineMapDocument, preset: MapPreset): Array<MapChange> {
  return arrowChanges(
    map,
    (from, to) =>
      preset.arrows.find((arrow) => arrow.from === from && arrow.to === to) ??
      defaultArrow(from, to),
  );
}

/**
 * MM-706: every arrow becomes `none` and every map role becomes `none`. It changes only map
 * arrows and map roles. Owner access goes through Cloudflare Access, which lockdown never edits.
 */
export function lockdownChanges(map: MachineMapDocument): Array<MapChange> {
  const changes = arrowChanges(map, defaultArrow);
  for (const machine of map.machines) {
    if (machine.mapRole !== "none") {
      changes.push({ _tag: "putMachine", machine: { ...machine, mapRole: "none" } });
    }
  }
  return changes;
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * MM-704: the changes that return `current` to `target`. Machines are not added or removed,
 * because that also needs a machine token: the restore keeps the current machines and restores
 * their names, kinds, places and map roles. Pair cards and notes return too.
 */
export function restoreChanges(
  current: MachineMapDocument,
  target: MachineMapDocument,
): Array<MapChange> {
  const changes: Array<MapChange> = [];
  for (const machine of current.machines) {
    const old = findMachine(target, machine.id);
    if (!old) continue;
    const next = {
      ...machine,
      name: old.name,
      kind: old.kind,
      position: old.position,
      mapRole: old.mapRole,
    };
    if (!sameValue(next, machine)) changes.push({ _tag: "putMachine", machine: next });
  }
  const restoredMachines = current.machines.filter((m) => findMachine(target, m.id));
  changes.push(
    ...arrowChanges(current, (from, to) =>
      restoredMachines.some((m) => m.id === from) && restoredMachines.some((m) => m.id === to)
        ? findArrow(target, from, to)
        : findArrow(current, from, to),
    ),
  );

  for (const { scope, key } of target.settings.managed) {
    if (!isManaged(current, scope, key))
      changes.push({ _tag: "manageSetting", scope, key, managed: true });
  }
  for (const { scope, key } of target.settings.managed) {
    changes.push(
      ...settingValueChanges(
        current,
        target,
        scope,
        key,
        restoredMachines.map((m) => m.id),
      ),
    );
  }
  for (const { scope, key } of current.settings.managed) {
    if (!isManaged(target, scope, key))
      changes.push({ _tag: "manageSetting", scope, key, managed: false });
  }

  for (const preset of target.presets) {
    const now = current.presets.find((p) => p.name === preset.name);
    if (!now || !sameValue(now, preset)) changes.push({ _tag: "putPreset", preset });
  }
  for (const preset of current.presets) {
    if (!target.presets.some((p) => p.name === preset.name)) {
      changes.push({ _tag: "removePreset", name: preset.name });
    }
  }

  for (const [i, a] of restoredMachines.entries()) {
    for (const b of restoredMachines.slice(i + 1)) {
      const offset = pairOffset(target, a.id, b.id);
      if (!sameValue(offset, pairOffset(current, a.id, b.id))) {
        changes.push({ _tag: "placePair", a: a.id, b: b.id, offset });
      }
    }
  }
  for (const note of target.notes) {
    if (!sameValue(note, findNote(current, note.id))) changes.push({ _tag: "putNote", note });
  }
  for (const note of current.notes) {
    if (!findNote(target, note.id)) changes.push({ _tag: "removeNote", id: note.id });
  }
  return changes;
}

function settingValueChanges(
  current: MachineMapDocument,
  target: MachineMapDocument,
  scope: SettingScope,
  key: string,
  machineIds: ReadonlyArray<MachineId>,
): Array<MapChange> {
  const changes: Array<MapChange> = [];
  const shared = (map: MachineMapDocument) => map.settings.shared[scope];
  const pushIfDifferent = (
    machineId: MachineId | null,
    now: Record<string, unknown> | undefined,
    old: Record<string, unknown> | undefined,
  ) => {
    const nowPresent = now !== undefined && Object.hasOwn(now, key);
    const oldPresent = old !== undefined && Object.hasOwn(old, key);
    if (nowPresent === oldPresent && (!oldPresent || sameValue(now?.[key], old?.[key]))) return;
    changes.push({
      _tag: "setSetting",
      machineId,
      scope,
      key,
      present: oldPresent,
      value: oldPresent ? old?.[key] : null,
    });
  };
  pushIfDifferent(null, shared(current), shared(target));
  for (const id of machineIds) {
    pushIfDifferent(
      id,
      current.settings.overrides[id]?.[scope],
      target.settings.overrides[id]?.[scope],
    );
  }
  return changes;
}

/** MM-710: the arrows and map roles before an emergency pause. Resume returns to them. */
export const PausedAccess = Schema.Struct({
  arrows: Schema.Array(ArrowRecord),
  /** Every machine on the map at the pause, by machine id. */
  mapRoles: Schema.Record(Schema.String, MachineMapRole),
});
export type PausedAccess = typeof PausedAccess.Type;

export const pausedAccess = (map: MachineMapDocument): PausedAccess => ({
  arrows: map.arrows,
  mapRoles: Object.fromEntries(map.machines.map((machine) => [machine.id, machine.mapRole])),
});

/**
 * MM-712: the changes that return the arrows and map roles to `before`. A machine that joined
 * during the pause keeps `none`, and so do the arrows that touch it. Machines that left are skipped.
 */
export function resumeChanges(map: MachineMapDocument, before: PausedAccess): Array<MapChange> {
  const changes: Array<MapChange> = [];
  for (const machine of map.machines) {
    const role = before.mapRoles[machine.id];
    if (role !== undefined && role !== machine.mapRole) {
      changes.push({ _tag: "putMachine", machine: { ...machine, mapRole: role } });
    }
  }
  const wasThere = (id: MachineId) => Object.hasOwn(before.mapRoles, id);
  changes.push(
    ...arrowChanges(map, (from, to) =>
      wasThere(from) && wasThere(to)
        ? (before.arrows.find((arrow) => arrow.from === from && arrow.to === to) ??
          defaultArrow(from, to))
        : findArrow(map, from, to),
    ),
  );
  return changes;
}

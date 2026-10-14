import { describe, expect, it } from "vite-plus/test";
import { MachineId, type MachineMapDocument } from "@t3tools/contracts/machineMap";

import { applyChanges, findArrow } from "./map.ts";
import {
  applyPresetChanges,
  cutArrows,
  lockdownChanges,
  pausedAccess,
  restoreChanges,
  resumeChanges,
  savePresetChange,
} from "./presets.ts";
import { MAC, machine, threeMachines, VPS, WIN } from "./testMap.ts";

const AT = "2026-10-13T08:00:00.000Z";

const busyMap = (): MachineMapDocument =>
  applyChanges(
    {
      ...threeMachines(),
      machines: [machine(MAC, { mapRole: "edit" }), machine(VPS), machine(WIN)],
    },
    [
      {
        _tag: "setArrow",
        arrow: { ...findArrow(threeMachines(), MAC, VPS), level: "admin", agentTools: true },
      },
      {
        _tag: "setArrow",
        arrow: {
          ...findArrow(threeMachines(), WIN, MAC),
          level: "standard",
          expiresAt: AT,
          revertLevel: "read",
        },
      },
      {
        _tag: "setSetting",
        machineId: null,
        scope: "server",
        key: "theme",
        present: true,
        value: "light",
      },
    ],
  ).map;

describe("lockdown (MM-706)", () => {
  it("sets every arrow and map role to none, and touches nothing else", () => {
    const map = busyMap();
    const changes = lockdownChanges(map);
    expect(changes.every((c) => c._tag === "setArrow" || c._tag === "putMachine")).toBe(true);
    const locked = applyChanges(map, changes).map;
    expect(locked.arrows).toEqual([]);
    expect(locked.machines.every((m) => m.mapRole === "none")).toBe(true);
    expect(locked.settings).toEqual(map.settings);
    expect(lockdownChanges(locked)).toEqual([]);
  });
});

describe("presets (MM-705)", () => {
  it("saves permanent levels and applies them back", () => {
    const map = busyMap();
    const save = savePresetChange(map, "work", AT);
    const saved = applyChanges(map, [save]).map;
    const preset = saved.presets[0];
    expect(preset?.arrows.find((a) => a.from === WIN)?.level).toBe("read");
    if (!preset) throw new Error("preset missing");
    const locked = applyChanges(saved, lockdownChanges(saved)).map;
    const restored = applyChanges(locked, applyPresetChanges(locked, preset)).map;
    expect(findArrow(restored, MAC, VPS)).toMatchObject({ level: "admin", agentTools: true });
    expect(findArrow(restored, WIN, MAC)).toMatchObject({ level: "read", expiresAt: null });
  });
});

describe("restoreChanges (MM-704)", () => {
  it("returns arrows, settings and machine fields to an older map", () => {
    const old = busyMap();
    const now = applyChanges(old, [
      ...lockdownChanges(old),
      {
        _tag: "putMachine",
        machine: { ...machine(VPS), name: "Cloud", position: { x: 0.1, y: 0.1 } },
      },
      {
        _tag: "setSetting",
        machineId: null,
        scope: "server",
        key: "theme",
        present: false,
        value: null,
      },
      {
        _tag: "setSetting",
        machineId: null,
        scope: "client",
        key: "font",
        present: true,
        value: "x",
      },
    ]).map;
    const restored = applyChanges(now, restoreChanges(now, old)).map;
    expect(restored.arrows).toEqual(old.arrows);
    expect(restored.machines).toEqual(old.machines);
    expect(restored.settings).toEqual(old.settings);
    expect(restoreChanges(restored, old)).toEqual([]);
  });

  it("returns card places and notes to an older map", () => {
    const note = {
      id: "n1",
      text: "hello",
      color: "pink" as const,
      position: { x: 0.2, y: 0.2 },
    };
    const old = applyChanges(threeMachines(), [
      { _tag: "placePair", a: MAC, b: VPS, offset: { along: 0.3, aside: 0 } },
      { _tag: "putNote", note },
    ]).map;
    const now = applyChanges(old, [
      { _tag: "placePair", a: MAC, b: VPS, offset: null },
      { _tag: "placePair", a: VPS, b: WIN, offset: { along: 0.5, aside: 0.2 } },
      { _tag: "putNote", note: { ...note, text: "changed" } },
      { _tag: "putNote", note: { ...note, id: "n2" } },
    ]).map;
    const restored = applyChanges(now, restoreChanges(now, old)).map;
    expect(restored.pairPlacements).toEqual(old.pairPlacements);
    expect(restored.notes).toEqual(old.notes);
  });

  it("keeps machines that the older map does not have", () => {
    const old = threeMachines();
    const now = { ...busyMap(), machines: [...busyMap().machines, machine(MachineId.make("new"))] };
    const restored = applyChanges(now, restoreChanges(now, old)).map;
    expect(restored.machines.map((m) => m.id)).toContain("new");
  });
});

describe("emergency pause and resume (MM-710, MM-712)", () => {
  it("resume returns the arrows and map roles from before the pause", () => {
    const map = busyMap();
    const before = pausedAccess(map);
    const paused = applyChanges(map, lockdownChanges(map)).map;
    const resumed = applyChanges(paused, resumeChanges(paused, before)).map;
    expect(resumed.arrows).toEqual(map.arrows);
    expect(resumed.machines).toEqual(map.machines);
    expect(resumeChanges(resumed, before)).toEqual([]);
  });

  it("keeps a machine that joined during the pause at none, and skips one that left", () => {
    const map = busyMap();
    const before = pausedAccess(map);
    const NEW = MachineId.make("new");
    const paused = applyChanges(map, [
      ...lockdownChanges(map),
      { _tag: "removeMachine", machineId: VPS },
      { _tag: "putMachine", machine: machine(NEW) },
    ]).map;
    const resumed = applyChanges(paused, resumeChanges(paused, before)).map;
    expect(resumed.machines.map((m) => m.id)).toEqual([MAC, WIN, NEW]);
    expect(resumed.machines.find((m) => m.id === MAC)?.mapRole).toBe("edit");
    expect(resumed.machines.find((m) => m.id === NEW)?.mapRole).toBe("none");
    expect(findArrow(resumed, WIN, MAC)).toEqual(findArrow(map, WIN, MAC));
    expect(findArrow(resumed, NEW, MAC).level).toBe("none");
    expect(resumed.arrows.some((a) => a.from === VPS || a.to === VPS)).toBe(false);
  });

  it("lists the arrows that the pause cut, with their old level, for the map (MM-717)", () => {
    const map = busyMap();
    const before = pausedAccess(map);
    const paused = applyChanges(map, lockdownChanges(map)).map;
    expect(cutArrows(paused, before)).toEqual([
      { from: MAC, to: VPS, level: "admin" },
      { from: WIN, to: MAC, level: "standard" },
    ]);
    const vpsLeft = applyChanges(paused, [{ _tag: "removeMachine", machineId: VPS }]).map;
    expect(cutArrows(vpsLeft, before)).toEqual([{ from: WIN, to: MAC, level: "standard" }]);
    expect(cutArrows(map, before)).toEqual([]);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { MachineId, type MachineMapDocument } from "@t3tools/contracts/machineMap";

import { applyChanges, findArrow } from "./map.ts";
import {
  applyPresetChanges,
  lockdownChanges,
  restoreChanges,
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
      { _tag: "manageSetting", scope: "server", key: "theme", managed: true },
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
      { _tag: "manageSetting", scope: "server", key: "theme", managed: false },
      { _tag: "manageSetting", scope: "client", key: "font", managed: true },
    ]).map;
    const restored = applyChanges(now, restoreChanges(now, old)).map;
    expect(restored.arrows).toEqual(old.arrows);
    expect(restored.machines).toEqual(old.machines);
    expect(restored.settings).toEqual(old.settings);
    expect(restoreChanges(restored, old)).toEqual([]);
  });

  it("keeps machines that the older map does not have", () => {
    const old = threeMachines();
    const now = { ...busyMap(), machines: [...busyMap().machines, machine(MachineId.make("new"))] };
    const restored = applyChanges(now, restoreChanges(now, old)).map;
    expect(restored.machines.map((m) => m.id)).toContain("new");
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  MachineId,
  type MachineMapDocument,
  type MapChange,
  type MapPosition,
} from "@t3tools/contracts/machineMap";

import {
  applyChanges,
  checkEditableChanges,
  desiredState,
  findArrow,
  freePosition,
  machinesTouched,
  MapRuleError,
} from "./map.ts";
import { MAC, machine, threeMachines, VPS, WIN } from "./testMap.ts";

const managed = (map: MachineMapDocument): MachineMapDocument =>
  applyChanges(map, [
    { _tag: "manageSetting", scope: "server", key: "theme", managed: true },
    {
      _tag: "setSetting",
      machineId: null,
      scope: "server",
      key: "theme",
      present: true,
      value: "light",
    },
    {
      _tag: "setSetting",
      machineId: VPS,
      scope: "server",
      key: "theme",
      present: true,
      value: "dark",
    },
  ]).map;

describe("applyChanges", () => {
  // Every change kind, so the round trip covers each inverse (MM-703).
  const everyChange = (map: MachineMapDocument): ReadonlyArray<MapChange> => [
    {
      _tag: "setArrow",
      arrow: {
        from: MAC,
        to: VPS,
        level: "admin",
        agentTools: true,
        expiresAt: null,
        revertLevel: null,
      },
    },
    {
      _tag: "setSetting",
      machineId: MAC,
      scope: "server",
      key: "theme",
      present: true,
      value: "x",
    },
    {
      _tag: "setSetting",
      machineId: null,
      scope: "server",
      key: "theme",
      present: false,
      value: null,
    },
    { _tag: "manageSetting", scope: "client", key: "font", managed: true },
    { _tag: "putMachine", machine: { ...machine(MAC), name: "Mac", position: { x: 0.1, y: 0.2 } } },
    {
      _tag: "putPreset",
      preset: { name: "day", arrows: map.arrows, createdAt: "2026-10-02T00:00:00.000Z" },
    },
    { _tag: "removeMachine", machineId: VPS },
    { _tag: "manageSetting", scope: "server", key: "theme", managed: false },
  ];

  it("undoes every change kind with its inverse", () => {
    const before = managed(threeMachines());
    const applied = applyChanges(before, everyChange(before));
    expect(applied.map).not.toEqual(before);
    const undone = applyChanges(applied.map, applied.inverse).map;
    const byId = (list: MachineMapDocument["machines"]) =>
      [...list].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(undone.machines)).toEqual(byId(before.machines));
    expect(undone.settings.shared).toEqual(before.settings.shared);
    expect(undone.settings.overrides).toEqual(before.settings.overrides);
    expect([...undone.settings.managed].sort((a, b) => a.key.localeCompare(b.key))).toEqual(
      [...before.settings.managed].sort((a, b) => a.key.localeCompare(b.key)),
    );
    expect(undone.arrows).toEqual(before.arrows);
    expect(undone.presets).toEqual(before.presets);
  });

  it("removes the arrows and overrides of a removed machine (MM-208)", () => {
    const map = applyChanges(managed(threeMachines()), [
      { _tag: "setArrow", arrow: { ...findArrow(threeMachines(), VPS, MAC), level: "read" } },
      { _tag: "removeMachine", machineId: VPS },
    ]).map;
    expect(map.machines.map((m) => m.id)).toEqual([MAC, WIN]);
    expect(map.arrows).toEqual([]);
    expect(map.settings.overrides[VPS]).toBeUndefined();
  });

  it("refuses broken changes", () => {
    const map = threeMachines();
    const self = { ...findArrow(map, MAC, MAC), level: "read" as const };
    expect(() => applyChanges(map, [{ _tag: "setArrow", arrow: self }])).toThrow(MapRuleError);
    expect(() =>
      applyChanges(map, [
        { _tag: "setSetting", machineId: null, scope: "server", key: "x", present: true, value: 1 },
      ]),
    ).toThrow(/not managed/);
    expect(() =>
      applyChanges(map, [
        { _tag: "putMachine", machine: machine(WIN, { tokenClientId: "mac.access" }) },
      ]),
    ).toThrow(/already uses/);
  });
});

describe("checkEditableChanges", () => {
  it("keeps machine creation, removal, tokens and hostnames for the portal", () => {
    const map = threeMachines();
    expect(() => checkEditableChanges(map, [{ _tag: "removeMachine", machineId: MAC }])).toThrow();
    expect(() =>
      checkEditableChanges(map, [{ _tag: "putMachine", machine: machine(MachineId.make("new")) }]),
    ).toThrow();
    expect(() =>
      checkEditableChanges(map, [
        { _tag: "putMachine", machine: { ...machine(MAC), hostname: "evil" } },
      ]),
    ).toThrow();
    expect(() =>
      checkEditableChanges(map, [
        { _tag: "putMachine", machine: { ...machine(MAC), name: "Mac" } },
      ]),
    ).not.toThrow();
  });
});

describe("machinesTouched", () => {
  const touched = (map: MachineMapDocument, changes: ReadonlyArray<MapChange>) =>
    machinesTouched({ changes, inverse: applyChanges(map, changes).inverse });

  it("names both ends of an arrow, and nobody for a move", () => {
    const map = threeMachines();
    expect(
      touched(map, [{ _tag: "setArrow", arrow: { ...findArrow(map, MAC, VPS), level: "read" } }]),
    ).toEqual(new Set([MAC, VPS]));
    const move = { ...machine(MAC), position: { x: 0.9, y: 0.9 } };
    expect(touched(map, [{ _tag: "putMachine", machine: move }])).toEqual(new Set());
    expect(touched(map, [{ _tag: "putMachine", machine: { ...machine(MAC), name: "Mac" } }])).toBe(
      "all",
    );
    expect(
      touched(map, [{ _tag: "putMachine", machine: { ...machine(MAC), mapRole: "read" } }]),
    ).toEqual(new Set([MAC]));
  });
});

describe("desiredState", () => {
  it("holds only the machine's own arrows and settings (MM-1202)", () => {
    const map = applyChanges(managed(threeMachines()), [
      { _tag: "setArrow", arrow: { ...findArrow(threeMachines(), MAC, VPS), level: "admin" } },
      { _tag: "setArrow", arrow: { ...findArrow(threeMachines(), WIN, MAC), level: "read" } },
    ]).map;
    const state = desiredState(map, VPS);
    expect(state?.self.id).toBe(VPS);
    expect(state?.peers.map((p) => p.id)).toEqual([MAC, WIN]);
    expect(state?.peers[0]).not.toHaveProperty("position");
    expect(state?.arrowsIn.map((a) => [a.from, a.level])).toEqual([
      [MAC, "admin"],
      [WIN, "none"],
    ]);
    expect(state?.arrowsOut.every((a) => a.from === VPS)).toBe(true);
    expect(state?.settings).toEqual({ server: { theme: "dark" }, client: {} });
    expect(desiredState(map, MAC)?.settings).toEqual({ server: { theme: "light" }, client: {} });
    expect(desiredState(map, MachineId.make("gone"))).toBeUndefined();
  });
});

describe("freePosition (MM-206)", () => {
  it("puts the first machine in the middle and spreads the next ones apart", () => {
    const taken: Array<MapPosition> = [];
    for (let i = 0; i < 8; i++) taken.push(freePosition(taken));
    expect(taken[0]).toEqual({ x: 0.5, y: 0.5 });
    expect(new Set(taken.map((p) => `${p.x},${p.y}`)).size).toBe(taken.length);
    for (const [i, a] of taken.entries())
      for (const b of taken.slice(i + 1))
        expect(Math.hypot((a.x - b.x) * 1.6, a.y - b.y)).toBeGreaterThan(0.3);
  });
});

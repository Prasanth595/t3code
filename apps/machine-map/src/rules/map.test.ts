import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  MachineId,
  MachineMapDocument,
  type MapNote,
  type MapChange,
  type MapPosition,
} from "@t3tools/contracts/machineMap";

import {
  applyChanges,
  checkEditableChanges,
  desiredState,
  findArrow,
  freePosition,
  emptyMap,
  machinesTouched,
  MapRuleError,
  pairOffset,
  keepClientKeys,
  undoChanges,
} from "./map.ts";
import { client, MAC, machine, PHONE, threeMachines, VPS, WIN } from "./testMap.ts";

const managed = (map: MachineMapDocument): MachineMapDocument =>
  applyChanges(map, [
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
    { _tag: "putMachine", machine: { ...machine(MAC), name: "Mac", position: { x: 0.1, y: 0.2 } } },
    {
      _tag: "putPreset",
      preset: { name: "day", arrows: map.arrows, createdAt: "2026-10-02T00:00:00.000Z" },
    },
    { _tag: "removeMachine", machineId: VPS },
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
        {
          _tag: "setSetting",
          machineId: null,
          scope: "server",
          key: "machineMap",
          present: true,
          value: {},
        },
      ]),
    ).toThrow(/belongs to each machine/);
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

  it("keeps keys from a stale record, and an undo never adds a key back (MM-720, MM-909)", () => {
    const later = { thumbprint: "key-2", addedAt: "2026-10-02T00:00:00.000Z", describedAs: "x" };
    const map = applyChanges(threeMachines(), [
      { _tag: "putClient", client: client() },
      { _tag: "addClientKey", clientId: PHONE, key: later },
    ]).map;
    // A draft or an open panel built before the second key was approved.
    const stale = keepClientKeys(map, [{ _tag: "putClient", client: client({ name: "iPhone" }) }]);
    const renamed = applyChanges(map, stale).map.clients[0];
    expect(renamed?.name).toBe("iPhone");
    expect(renamed?.keys.map((k) => k.thumbprint)).toEqual(["key-1", "key-2"]);
    const removal = applyChanges(map, [
      { _tag: "removeClientKey", clientId: PHONE, thumbprint: "key-2" },
    ]);
    expect(() =>
      checkEditableChanges(removal.map, undoChanges(removal.map, removal.inverse)),
    ).toThrow();
  });

  it("skips the arrows of a client that left in the undo of an old machine removal", () => {
    const map = applyChanges(threeMachines(), [
      { _tag: "putClient", client: client() },
      {
        _tag: "setClientArrow",
        arrow: { client: PHONE, to: WIN, level: "read", expiresAt: null, revertLevel: null },
      },
    ]).map;
    const removed = applyChanges(map, [{ _tag: "removeMachine", machineId: WIN }]);
    const clientGone = applyChanges(removed.map, [{ _tag: "removeClient", clientId: PHONE }]).map;
    const undo = undoChanges(clientGone, removed.inverse);
    expect(undo.some((c) => c._tag === "setClientArrow")).toBe(false);
    expect(applyChanges(clientGone, undo).map.machines.map((m) => m.id)).toContain(WIN);
  });

  it("lets a browser key in only through an approval (MM-907)", () => {
    const map = applyChanges(threeMachines(), [{ _tag: "putClient", client: client() }]).map;
    const newKey = { thumbprint: "key-2", addedAt: "2026-10-02T00:00:00.000Z", describedAs: "x" };
    expect(() =>
      checkEditableChanges(threeMachines(), [{ _tag: "putClient", client: client() }]),
    ).toThrow();
    expect(() =>
      checkEditableChanges(map, [{ _tag: "addClientKey", clientId: PHONE, key: newKey }]),
    ).toThrow();
    expect(() =>
      checkEditableChanges(map, [
        { _tag: "putClient", client: client({ keys: [...client().keys, newKey] }) },
      ]),
    ).toThrow();
    expect(() =>
      checkEditableChanges(map, [{ _tag: "putClient", client: client({ name: "iPhone" }) }]),
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
    const state = desiredState(map, VPS, false);
    expect(state?.self.id).toBe(VPS);
    expect(state?.peers.map((p) => p.id)).toEqual([MAC, WIN]);
    expect(state?.peers[0]).not.toHaveProperty("position");
    expect(state?.arrowsIn.map((a) => [a.from, a.level])).toEqual([
      [MAC, "admin"],
      [WIN, "none"],
    ]);
    expect(state?.arrowsOut.every((a) => a.from === VPS)).toBe(true);
    expect(state?.settings).toEqual({ server: { theme: "dark" }, client: {} });
    expect(desiredState(map, MAC, false)?.settings).toEqual({
      server: { theme: "light" },
      client: {},
    });
    expect(desiredState(map, MachineId.make("gone"), false)).toBeUndefined();
  });

  it("says paused while the emergency pause is on, and not paused after Resume (MM-718)", () => {
    const map = threeMachines();
    expect(desiredState(map, MAC, true)?.paused).toBe(true);
    expect(desiredState(map, MAC, false)?.paused).toBe(false);
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

const decodeMap = Schema.decodeUnknownSync(MachineMapDocument);

describe("display data (MM-1108, MM-1109)", () => {
  it("decodes places outside 0..1, so a later portal can write map pixels (MM-1114)", () => {
    const map = {
      ...threeMachines(),
      machines: [{ ...machine(MAC), position: { x: 350, y: -20 } }],
    };
    expect(decodeMap(map).machines[0]?.position).toEqual({ x: 350, y: -20 });
  });

  const note: MapNote = {
    id: "n1",
    text: "Mac is the main box",
    color: "yellow",
    position: { x: 0.3, y: 0.4 },
  };
  const display: ReadonlyArray<MapChange> = [
    { _tag: "placePair", a: WIN, b: MAC, offset: { along: 0.25, aside: 0.1 } },
    { _tag: "putNote", note },
    { _tag: "putNote", note: { ...note, position: { x: 0.6, y: 0.4 } } },
  ];

  it("stores a pair offset once, whichever end names it first", () => {
    const map = applyChanges(threeMachines(), display).map;
    expect(map.pairPlacements).toHaveLength(1);
    expect(pairOffset(map, WIN, MAC)).toEqual({ along: 0.25, aside: 0.1 });
    expect(pairOffset(map, MAC, WIN)).toEqual({ along: 0.75, aside: -0.1 });
    const reset = applyChanges(map, [{ _tag: "placePair", a: MAC, b: WIN, offset: null }]).map;
    expect(reset.pairPlacements).toEqual([]);
    expect(pairOffset(reset, MAC, WIN)).toBeNull();
  });

  it("undoes pair placements and notes with their inverse", () => {
    const before = threeMachines();
    const applied = applyChanges(before, [...display, { _tag: "removeNote", id: "n1" }]);
    expect(applied.map.notes).toEqual([]);
    const undone = applyChanges(applied.map, applied.inverse).map;
    expect(undone.pairPlacements).toEqual(before.pairPlacements);
    expect(undone.notes).toEqual(before.notes);
    const withNote = applyChanges(before, display);
    expect(applyChanges(withNote.map, withNote.inverse).map).toEqual(before);
  });

  it("never changes what a machine applies, so it queues nothing (MM-603)", () => {
    const before = threeMachines();
    const applied = applyChanges(before, display);
    const revision = { changes: display, inverse: applied.inverse };
    expect(machinesTouched(revision)).toEqual(new Set());
    for (const m of before.machines) {
      expect(desiredState(applied.map, m.id, false)).toEqual(desiredState(before, m.id, false));
    }
  });

  it("drops the card place of a removed machine, and the inverse brings it back", () => {
    const map = applyChanges(threeMachines(), display).map;
    const removed = applyChanges(map, [{ _tag: "removeMachine", machineId: WIN }]);
    expect(removed.map.pairPlacements).toEqual([]);
    expect(applyChanges(removed.map, removed.inverse).map.pairPlacements).toEqual(
      map.pairPlacements,
    );
  });

  it("refuses a pair of unknown machines and a note that is gone", () => {
    const map = threeMachines();
    const ghost = MachineId.make("ghost");
    expect(() =>
      applyChanges(map, [{ _tag: "placePair", a: MAC, b: ghost, offset: null }]),
    ).toThrow(MapRuleError);
    expect(() => applyChanges(map, [{ _tag: "removeNote", id: "nope" }])).toThrow(MapRuleError);
  });

  it("decodes a map saved before display data with no notes and no card places", () => {
    const { pairPlacements: _p, notes: _n, ...old } = emptyMap();
    const decoded = decodeMap(old);
    expect(decoded.pairPlacements).toEqual([]);
    expect(decoded.notes).toEqual([]);
  });
});

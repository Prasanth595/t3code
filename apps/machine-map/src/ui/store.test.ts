import { describe, expect, it } from "vite-plus/test";
import { MachineId, type PortalSnapshot } from "@t3tools/contracts/machineMap";

import { emptyMap } from "../rules/map.ts";
import { machine, MAC } from "../rules/testMap.ts";
import { INITIAL_STATE, reduce, settleHeldPositions, type HeldPosition } from "./store.ts";

const snapshot: PortalSnapshot = {
  map: emptyMap(),
  presence: {},
  reportedSettings: {},
  commands: [],
  history: [],
  proposals: [],
};

describe("reduce (MM-106)", () => {
  it("ignores events before the first snapshot", () => {
    const presence = { online: true, lastSeenAt: null, appliedRevision: null, status: null };
    expect(
      reduce(INITIAL_STATE, { _tag: "presence", machineId: MachineId.make("mac"), presence }),
    ).toBe(INITIAL_STATE);
  });

  it("puts a new revision first and replaces the map", () => {
    const state = reduce(INITIAL_STATE, { _tag: "snapshot", snapshot });
    const map = { ...emptyMap(), revision: 1 };
    const revision = {
      revision: 1,
      at: "2026-10-13T08:00:00.000Z",
      actor: { _tag: "portal" as const, reason: "test" },
      summary: "first",
      changes: [],
      inverse: [],
    };
    const next = reduce(state, { _tag: "revision", revision, map });
    expect(next.snapshot?.map.revision).toBe(1);
    expect(next.snapshot?.history.map((r) => r.revision)).toEqual([1]);
    expect(reduce(next, { _tag: "revision", revision, map }).snapshot?.history).toHaveLength(1);
  });
});

describe("settleHeldPositions", () => {
  const map = { ...emptyMap(), revision: 4, machines: [machine(MAC)] };
  const dropped = { x: 0.2, y: 0.7 };
  const held = (revision: number | null): HeldPosition => ({
    machineId: machine(MAC).id,
    position: dropped,
    revision,
  });

  it("keeps a dropped position until the map has it", () => {
    const waiting = [held(null)];
    expect(settleHeldPositions(waiting, map)).toBe(waiting);
    const echoed = { ...map, machines: [{ ...machine(MAC), position: dropped }] };
    expect(settleHeldPositions(waiting, echoed)).toEqual([]);
  });

  it("keeps a saved position until the map reaches its revision", () => {
    const saved = [held(5)];
    expect(settleHeldPositions(saved, map)).toBe(saved);
    // From that revision on the map position wins, also when a later revision moved it again.
    expect(settleHeldPositions(saved, { ...map, revision: 6 })).toEqual([]);
  });

  it("drops the position of a removed machine", () => {
    expect(settleHeldPositions([held(null)], { ...map, machines: [] })).toEqual([]);
  });
});

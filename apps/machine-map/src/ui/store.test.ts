import { describe, expect, it } from "vite-plus/test";
import { MachineId, type PortalSnapshot } from "@t3tools/contracts/machineMap";

import { emptyMap } from "../rules/map.ts";
import { INITIAL_STATE, reduce, settleHeld, type Held } from "./store.ts";

const snapshot: PortalSnapshot = {
  placeUnits: "fractions",
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

  it("counts joins per machine, also before the first snapshot (MM-212)", () => {
    const event = { _tag: "enrolled" as const, machineId: MachineId.make("mac") };
    expect(reduce(reduce(INITIAL_STATE, event), event).joins).toEqual({ mac: 2 });
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

describe("settleHeld", () => {
  const dropped = 7;
  const held = (revision: number | null): Held<number> => ({
    key: "card",
    value: dropped,
    revision,
  });
  const same = (a: number, b: number) => a === b;
  const savedAs = (value: number | undefined) => () => value;

  it("keeps a dropped place until the map has it", () => {
    const waiting = [held(null)];
    expect(settleHeld(waiting, 4, savedAs(1), same)).toBe(waiting);
    expect(settleHeld(waiting, 4, savedAs(dropped), same)).toEqual([]);
  });

  it("keeps a saved place until the map reaches its revision", () => {
    const saved = [held(5)];
    expect(settleHeld(saved, 4, savedAs(1), same)).toBe(saved);
    // From that revision on the map place wins, also when a later revision moved it again.
    expect(settleHeld(saved, 6, savedAs(1), same)).toEqual([]);
  });

  it("drops the place of a card that is gone", () => {
    expect(settleHeld([held(null)], 4, savedAs(undefined), same)).toEqual([]);
  });
});

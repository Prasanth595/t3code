import { describe, expect, it } from "vite-plus/test";
import { MachineId, type PortalSnapshot } from "@t3tools/contracts/machineMap";

import { emptyMap } from "../rules/map.ts";
import { INITIAL_STATE, reduce } from "./store.ts";

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

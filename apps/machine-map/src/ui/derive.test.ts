import { describe, expect, it } from "vite-plus/test";
import type {
  MachineId,
  MachineMapDocument,
  MachinePresence,
  MachineRecord,
  MapChange,
  MapRevision,
  PortalSnapshot,
} from "@t3tools/contracts/machineMap";

import { applyChanges, findArrow, findMachine } from "../rules/map.ts";
import { MAC, threeMachines, VPS, WIN } from "../rules/testMap.ts";
import {
  arrowEnds,
  arrowEndWait,
  connectChange,
  machineQueue,
  pairShows,
  pauseReach,
} from "./derive.ts";

describe("machineQueue (MM-602)", () => {
  const map = threeMachines();
  const changes = [
    { _tag: "setArrow" as const, arrow: { ...findArrow(map, MAC, VPS), level: "read" as const } },
  ];
  const snapshot = (presence: MachinePresence): PortalSnapshot => ({
    placeUnits: "pixels",
    map,
    presence: { [MAC]: presence },
    reportedSettings: {},
    commands: [],
    history: [
      {
        revision: 1,
        at: "2026-10-13T08:00:00.000Z",
        actor: { _tag: "portal", reason: "test" },
        summary: "s",
        changes,
        inverse: applyChanges(map, changes).inverse,
      },
    ],
    proposals: [],
  });
  const mac = map.machines[0]!;

  it("does not count work for a machine that never joined", () => {
    const queue = machineQueue(
      snapshot({ online: false, lastSeenAt: null, appliedRevision: null, status: null }),
      [],
      mac,
    );
    expect(queue.waitingToJoin).toBe(true);
    expect(queue.count).toBe(0);
  });

  it("counts work for a machine that joined once and is now offline", () => {
    const queue = machineQueue(
      snapshot({
        online: false,
        lastSeenAt: "2026-10-12T08:00:00.000Z",
        appliedRevision: null,
        status: null,
      }),
      [],
      mac,
    );
    expect(queue.waitingToJoin).toBe(false);
    expect(queue.count).toBe(1);
  });
});

describe("arrowEnds (MM-602, MM-604)", () => {
  const online: MachinePresence = {
    online: true,
    lastSeenAt: "2026-10-13T08:00:00.000Z",
    appliedRevision: 2,
    status: null,
  };
  const never: MachinePresence = {
    online: false,
    lastSeenAt: null,
    appliedRevision: null,
    status: null,
  };

  /** Commits each list of changes as one revision and returns the history, newest first. */
  const commit = (start: MachineMapDocument, steps: ReadonlyArray<ReadonlyArray<MapChange>>) => {
    let map = start;
    const history: Array<MapRevision> = [];
    steps.forEach((changes, index) => {
      const applied = applyChanges(map, changes);
      map = applied.map;
      history.unshift({
        revision: index + 1,
        at: "2026-10-13T09:00:00.000Z",
        actor: { _tag: "portal", reason: "test" },
        summary: "s",
        changes,
        inverse: applied.inverse,
      });
    });
    return { map, history };
  };
  const put = (map: MachineMapDocument, id: MachineId, patch: Partial<MachineRecord>) => {
    const current = findMachine(map, id)!;
    return { _tag: "putMachine" as const, machine: { ...current, ...patch } };
  };
  const start = threeMachines();
  const grant = {
    _tag: "setArrow" as const,
    arrow: { ...findArrow(start, MAC, VPS), level: "read" as const },
  };
  const snapshot = (
    steps: ReadonlyArray<ReadonlyArray<MapChange>>,
    presence: Record<string, MachinePresence>,
  ): PortalSnapshot => {
    const { map, history } = commit(start, steps);
    return {
      placeUnits: "pixels",
      map,
      presence,
      reportedSettings: {},
      commands: [],
      history,
      proposals: [],
    };
  };

  it("does not queue an arrow or a machine for moves after the applied revision", () => {
    const steps = [
      [grant],
      [put(start, MAC, { hostname: "mac.new.example.com" })],
      [put(start, MAC, { hostname: "mac.new.example.com", position: { x: 0.1, y: 0.1 } })],
      [put(start, VPS, { position: { x: 0.9, y: 0.9 } })],
    ];
    const map = snapshot(steps, { [MAC]: online, [VPS]: { ...online, appliedRevision: 2 } });
    expect(arrowEnds(map, MAC, VPS)).toEqual({ from: "applied", to: "applied" });
    expect(machineQueue(map, [], findMachine(map.map, MAC)!).count).toBe(0);
  });

  it("queues an arrow for a joined machine that missed a hostname change of the other end", () => {
    const steps = [[grant], [put(start, VPS, { hostname: "vps.new.example.com" })]];
    const map = snapshot(steps, { [MAC]: { ...online, appliedRevision: 1 }, [VPS]: online });
    expect(arrowEnds(map, MAC, VPS)).toEqual({ from: "queued", to: "applied" });
  });

  it("waits for the end that never joined, not for the end that applied", () => {
    const steps = [[grant], [put(start, VPS, { position: { x: 0.9, y: 0.9 } })]];
    const map = snapshot(steps, { [MAC]: { ...online, appliedRevision: 1 }, [VPS]: never });
    const ends = arrowEnds(map, MAC, VPS);
    expect(ends).toEqual({ from: "applied", to: "waitingToJoin" });
    expect(arrowEndWait(ends.to, findMachine(map.map, VPS)!)).toBe("waiting for VPS to join");
    expect(machineQueue(map, [], findMachine(map.map, VPS)!).count).toBe(0);
  });
});

describe("pauseReach (MM-708 to MM-710)", () => {
  const online: MachinePresence = {
    online: true,
    lastSeenAt: "2026-10-13T08:00:00.000Z",
    appliedRevision: 1,
    status: null,
  };
  const start = threeMachines();
  const changes: Array<MapChange> = [
    { _tag: "setArrow", arrow: { ...findArrow(start, MAC, VPS), level: "read" } },
    { _tag: "setArrow", arrow: { ...findArrow(start, VPS, MAC), level: "none", agentTools: true } },
    { _tag: "putMachine", machine: { ...findMachine(start, WIN)!, mapRole: "edit" } },
  ];
  const snapshot = (map: MachineMapDocument): PortalSnapshot => ({
    placeUnits: "pixels",
    map,
    // Windows never connected.
    presence: { [MAC]: online, [VPS]: { ...online, online: false } },
    reportedSettings: {},
    commands: [],
    history: [],
    proposals: [],
  });

  it("counts the joined machines, the offline ones, and each arrow and map role the pause sets to none", () => {
    const map = applyChanges(start, changes).map;
    expect(pauseReach(snapshot(map))).toEqual({
      machines: 2,
      offline: 1,
      notJoined: 1,
      arrows: 2,
      mapRoles: 1,
    });
  });

  it("drops nothing on a map that is already locked down", () => {
    expect(pauseReach(snapshot(start))).toMatchObject({ arrows: 0, mapRoles: 0 });
  });
});

describe("pairShows (MM-1103)", () => {
  const set = (map: MachineMapDocument, from: MachineId, to: MachineId, level: "none" | "read") =>
    applyChanges(map, [{ _tag: "setArrow", arrow: { ...findArrow(map, from, to), level } }]).map;

  it("hides a pair with no access either way", () => {
    expect(pairShows(threeMachines(), MAC, VPS)).toBe(false);
  });

  it("shows a pair when either direction gives access", () => {
    const map = set(threeMachines(), VPS, MAC, "read");
    expect(pairShows(map, MAC, VPS)).toBe(true);
    expect(pairShows(map, VPS, MAC)).toBe(true);
    expect(pairShows(map, MAC, WIN)).toBe(false);
  });

  it("hides the pair again when both directions return to none", () => {
    const map = set(set(threeMachines(), MAC, VPS, "read"), MAC, VPS, "none");
    expect(pairShows(map, MAC, VPS)).toBe(false);
  });

  it("shows a temporary none that returns to access later", () => {
    const map = applyChanges(threeMachines(), [
      {
        _tag: "setArrow",
        arrow: {
          ...findArrow(threeMachines(), MAC, VPS),
          expiresAt: "2026-10-14T08:00:00.000Z",
          revertLevel: "standard",
        },
      },
    ]).map;
    expect(pairShows(map, MAC, VPS)).toBe(true);
  });
});

describe("connectChange (MM-1104)", () => {
  it("raises an arrow with no access to standard, in one direction only", () => {
    const map = threeMachines();
    const change = connectChange(map, MAC, VPS, false);
    expect(change).not.toBeNull();
    const next = applyChanges(map, change ? [change] : []).map;
    expect(findArrow(next, MAC, VPS)).toMatchObject({ level: "standard", expiresAt: null });
    expect(findArrow(next, VPS, MAC).level).toBe("none");
    expect(pairShows(next, MAC, VPS)).toBe(true);
  });

  it("keeps an arrow that already gives access", () => {
    const map = applyChanges(threeMachines(), [
      { _tag: "setArrow", arrow: { ...findArrow(threeMachines(), MAC, VPS), level: "admin" } },
    ]).map;
    expect(connectChange(map, MAC, VPS, false)).toBeNull();
  });

  it("raises nothing during a pause or onto the same machine", () => {
    expect(connectChange(threeMachines(), MAC, VPS, true)).toBeNull();
    expect(connectChange(threeMachines(), MAC, MAC, false)).toBeNull();
  });
});

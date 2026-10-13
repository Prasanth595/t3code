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
import { MAC, threeMachines, VPS } from "../rules/testMap.ts";
import { arrowEnds, arrowEndWait, machineQueue } from "./derive.ts";

describe("machineQueue (MM-602)", () => {
  const map = threeMachines();
  const changes = [
    { _tag: "setArrow" as const, arrow: { ...findArrow(map, MAC, VPS), level: "read" as const } },
  ];
  const snapshot = (presence: MachinePresence): PortalSnapshot => ({
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
    return { map, presence, reportedSettings: {}, commands: [], history, proposals: [] };
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

import { describe, expect, it } from "vite-plus/test";
import type {
  MachineCommand,
  MachinePresence,
  MachineStatus,
  MapRevision,
} from "@t3tools/contracts/machineMap";

import { applyChanges, findArrow } from "./map.ts";
import {
  canDeliver,
  earliest,
  localSettingChanges,
  sharedSettingChanges,
  pendingRevisions,
  supportsCommand,
} from "./queue.ts";
import { MAC, threeMachines, VPS, WIN } from "./testMap.ts";

const status = (runningTurns: number): MachineStatus => ({
  t3Version: "1.0.0",
  build: "live abc",
  hostname: null,
  uptimeSeconds: 1,
  runningTurns,
  waitingThreads: 0,
  scheduledTasks: 0,
  updateWaiting: null,
  cpuPercent: null,
  memoryPercent: null,
  commands: ["restartServer"],
  clients: [],
});

const presence = (online: boolean, runningTurns: number | null): MachinePresence => ({
  online,
  lastSeenAt: null,
  appliedRevision: null,
  status: runningTurns === null ? null : status(runningTurns),
});

const command = (delivery: "online" | "idle"): MachineCommand => ({
  id: "c1",
  machineId: MAC,
  input: { _tag: "restartServer" },
  delivery,
  actor: { _tag: "portal", reason: "test" },
  status: "queued",
  createdAt: "2026-10-13T08:00:00.000Z",
  updatedAt: "2026-10-13T08:00:00.000Z",
  expiresAt: "2026-10-14T08:00:00.000Z",
  result: null,
  error: null,
});

describe("canDeliver (MM-605)", () => {
  it("delivers online commands to any online machine", () => {
    expect(canDeliver(command("online"), presence(true, 3))).toBe(true);
    expect(canDeliver(command("online"), presence(false, 0))).toBe(false);
  });

  it("delivers idle commands only with no running turn", () => {
    expect(canDeliver(command("idle"), presence(true, 0))).toBe(true);
    expect(canDeliver(command("idle"), presence(true, 2))).toBe(false);
    expect(canDeliver(command("idle"), presence(true, null))).toBe(false);
  });

  it("never delivers twice", () => {
    expect(canDeliver({ ...command("online"), status: "delivered" }, presence(true, 0))).toBe(
      false,
    );
  });
});

describe("supportsCommand (MM-502)", () => {
  it("offers only reported commands", () => {
    expect(supportsCommand(status(0), "restartServer")).toBe(true);
    expect(supportsCommand(status(0), "stopAllAgents")).toBe(false);
    expect(supportsCommand(null, "restartServer")).toBe(false);
  });
});

describe("earliest", () => {
  it("finds the first time and refuses bad input", () => {
    expect(earliest([])).toBeNull();
    expect(earliest(["2026-10-13T09:00:00.000Z", "2026-10-13T08:00:00.000Z"])).toBe(
      Date.parse("2026-10-13T08:00:00.000Z"),
    );
    expect(() => earliest(["soon"])).toThrow();
  });
});

describe("pendingRevisions (MM-602)", () => {
  it("lists revisions after the applied one that touch the machine", () => {
    const map = threeMachines();
    const revision = (n: number, from: typeof MAC, to: typeof MAC): MapRevision => {
      const changes = [
        {
          _tag: "setArrow" as const,
          arrow: { ...findArrow(map, from, to), level: "read" as const },
        },
      ];
      return {
        revision: n,
        at: `2026-10-13T08:0${n}:00.000Z`,
        actor: { _tag: "portal", reason: "test" },
        summary: "s",
        changes,
        inverse: applyChanges(map, changes).inverse,
      };
    };
    const history = [revision(1, MAC, VPS), revision(2, VPS, WIN), revision(3, WIN, MAC)];
    const mac = { id: MAC, createdAt: "2026-10-13T08:00:00.000Z" };
    expect(pendingRevisions(history, mac, null).map((r) => r.revision)).toEqual([1, 3]);
    expect(pendingRevisions(history, mac, 1).map((r) => r.revision)).toEqual([3]);
    // A machine that joined after rev 1 does not wait for it.
    expect(
      pendingRevisions(history, { ...mac, createdAt: "2026-10-13T08:02:00.000Z" }, null).map(
        (r) => r.revision,
      ),
    ).toEqual([3]);
  });
});

describe("localSettingChanges (MM-404)", () => {
  const map = applyChanges(threeMachines(), [
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

  it("turns a local change of a shared setting into an override, and keeps others local", () => {
    expect(localSettingChanges(map, MAC, "server", { theme: "dark", notShared: 1 })).toEqual([
      {
        _tag: "setSetting",
        machineId: MAC,
        scope: "server",
        key: "theme",
        present: true,
        value: "dark",
      },
    ]);
  });

  it("clears the override when the machine returns to the shared value", () => {
    expect(localSettingChanges(map, VPS, "server", { theme: "light" })).toEqual([
      {
        _tag: "setSetting",
        machineId: VPS,
        scope: "server",
        key: "theme",
        present: false,
        value: null,
      },
    ]);
    expect(localSettingChanges(map, MAC, "server", { theme: "light" })).toEqual([]);
  });
  it("makes a change for all environments the shared value, never a machine-local key (MM-411)", () => {
    expect(sharedSettingChanges(map, "server", { theme: "dark", machineMap: {} })).toEqual([
      {
        _tag: "setSetting",
        machineId: null,
        scope: "server",
        key: "theme",
        present: true,
        value: "dark",
      },
      // VPS already keeps "dark": its own value goes.
      {
        _tag: "setSetting",
        machineId: VPS,
        scope: "server",
        key: "theme",
        present: false,
        value: null,
      },
    ]);
  });
});

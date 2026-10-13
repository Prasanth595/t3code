/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { MachineId } from "@t3tools/contracts/machineMap";
import type { HealthAlert, ResourceSample } from "@t3tools/contracts/machineMapResources";

import { HEALTH_TABLES, HealthStore } from "./healthStore.ts";
import {
  HOUR_MS,
  MAX_ENDED_ALERTS,
  MAX_MINUTE_POINTS,
  MINUTE_MS,
  MINUTE_RETENTION_MS,
} from "./rules/health.ts";

const MAC = MachineId.make("mac");
const VPS = MachineId.make("vps");
const T0 = Date.parse("2026-10-13T08:00:00.000Z");

/** The store on an in-memory `node:sqlite` database, like `ctx.storage.sql` in the Worker. */
function memoryStore() {
  const db = new DatabaseSync(":memory:");
  db.exec(HEALTH_TABLES);
  const store = new HealthStore({
    run: <T,>(query: string, ...bindings: Array<string | number | null>) =>
      db.prepare(query).all(...bindings) as Array<T>,
    transaction: (work) => {
      db.exec("BEGIN");
      try {
        work();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  });
  return { db, store };
}

const sample = (cpuPercent: number): ResourceSample => ({
  at: "2026-10-13T08:00:00.000Z",
  cpuPercent,
  cpuCount: 4,
  load: null,
  memoryUsedBytes: 1,
  memoryTotalBytes: 2,
  swapUsedBytes: null,
  swapTotalBytes: null,
  swapBytesPerSecond: null,
  diskUsedBytes: null,
  diskTotalBytes: null,
  netInBytesPerSecond: null,
  netOutBytesPerSecond: null,
  t3: null,
  agents: null,
  topCpu: null,
  topMemory: null,
});

const alert = (id: string, startedAt: number, endedAt: number | null): HealthAlert => ({
  id,
  machineId: MAC,
  kind: "cpu",
  startedAt: new Date(startedAt).toISOString(),
  endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
  value: 95,
  threshold: 90,
});

describe("HealthStore (MM-1503, MM-1505)", () => {
  it("keeps one minute point per minute and the hour point as the mean so far", () => {
    const { store } = memoryStore();
    store.record(MAC, sample(10), T0 + 1_000);
    // A second sample in the same minute replaces the first.
    store.record(MAC, sample(20), T0 + 30_000);
    store.record(MAC, sample(60), T0 + MINUTE_MS + 5_000);
    expect(store.points(MAC, "minute", 0).map((p) => [p.atMs, p.point.cpu])).toEqual([
      [T0, 20],
      [T0 + MINUTE_MS, 60],
    ]);
    expect(store.points(MAC, "hour", 0)).toEqual([
      { atMs: T0, point: expect.objectContaining({ cpu: 40, cpuMax: 60, memory: 50 }) },
    ]);
    expect(store.latest(new Set([MAC, VPS]))).toEqual({ [MAC]: sample(60) });
  });

  it("prunes minute points after 24 hours and caps each machine", () => {
    const { db, store } = memoryStore();
    const insert = db.prepare(
      "INSERT INTO resource_points (machine_id, step, at_ms, data) VALUES (?, 'm', ?, ?)",
    );
    const data = JSON.stringify({
      cpu: 1,
      cpuMax: 1,
      memory: null,
      disk: null,
      swap: null,
      agents: null,
      agentCpu: null,
    });
    const now = T0 + 48 * HOUR_MS;
    // Older than 24 hours: gone.
    insert.run(MAC, now - MINUTE_RETENTION_MS - MINUTE_MS, data);
    // More fresh points than the cap: only the newest stay.
    for (let i = 0; i < MAX_MINUTE_POINTS + 10; i += 1) insert.run(VPS, now - i * 1_000, data);
    store.record(MAC, sample(5), now);
    store.prune(now, [MAC, VPS]);
    expect(store.points(MAC, "minute", 0).map((p) => p.atMs)).toEqual([now]);
    const vps = store.points(VPS, "minute", 0);
    expect(vps).toHaveLength(MAX_MINUTE_POINTS);
    expect(vps.at(-1)?.atMs).toBe(now);
    // The hour point of `now` stays: it is within 30 days.
    expect(store.points(MAC, "hour", 0)).toHaveLength(1);
  });

  it("keeps active alerts, drops ended ones past 30 days or over the cap", () => {
    const { store } = memoryStore();
    const now = T0 + 40 * 24 * HOUR_MS;
    store.saveAlert(alert("old-active", T0, null));
    store.saveAlert(alert("old-ended", T0, T0 + MINUTE_MS));
    for (let i = 0; i < MAX_ENDED_ALERTS + 5; i += 1) {
      store.saveAlert(alert(`ended-${i}`, now - (i + 1) * MINUTE_MS, now - i * MINUTE_MS));
    }
    store.prune(now, [MAC]);
    const alerts = store.alerts(10_000);
    expect(alerts[0]?.id).toBe("old-active");
    expect(alerts.some((a) => a.id === "old-ended")).toBe(false);
    expect(alerts.filter((a) => a.endedAt !== null)).toHaveLength(MAX_ENDED_ALERTS);
    expect(store.alerts(0).map((a) => a.id)).toEqual(["old-active"]);
  });

  it("forgets a removed machine", () => {
    const { store } = memoryStore();
    store.record(MAC, sample(5), T0);
    store.saveAlert(alert("a", T0, null));
    store.removeMachine(MAC);
    expect(store.hasPoints()).toBe(false);
    expect(store.latest(new Set([MAC]))).toEqual({});
    expect(store.alerts(10)).toEqual([]);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { MachineId, type MachinePresence } from "@t3tools/contracts/machineMap";
import {
  DEFAULT_HEALTH_THRESHOLDS,
  type HealthAlert,
  type ResourceSample,
} from "@t3tools/contracts/machineMapResources";

import {
  alertChanges,
  averagePoints,
  historyOf,
  MINUTE_MS,
  offlineConditions,
  offlineDueAt,
  pointOf,
  resourceConditions,
  type ResourcePoint,
  type TimedPoint,
} from "./health.ts";

const MAC = MachineId.make("mac");
const T0 = Date.parse("2026-10-13T08:00:00.000Z");

const point = (overrides: Partial<ResourcePoint> = {}): ResourcePoint => ({
  cpu: 10,
  cpuMax: 10,
  memory: 50,
  disk: 40,
  swap: 0,
  agents: 2,
  agentCpu: 5,
  ...overrides,
});

/** One point a minute, oldest first. */
const minutes = (...points: Array<ResourcePoint>): Array<TimedPoint> =>
  points.map((p, i) => ({ atMs: T0 + i * MINUTE_MS, point: p }));

const alert = (kind: HealthAlert["kind"]): HealthAlert => ({
  id: kind,
  machineId: MAC,
  kind,
  startedAt: "2026-10-13T08:00:00.000Z",
  endedAt: null,
  value: 95,
  threshold: 90,
});

describe("points (MM-1503)", () => {
  it("turns a sample into percents, MB/s and the agent count", () => {
    const sample: ResourceSample = {
      at: "2026-10-13T08:00:00.000Z",
      cpuPercent: 33.3,
      cpuCount: 8,
      load: null,
      memoryUsedBytes: 3,
      memoryTotalBytes: 4,
      swapUsedBytes: null,
      swapTotalBytes: null,
      swapBytesPerSecond: 2_500_000,
      diskUsedBytes: 1,
      diskTotalBytes: 3,
      netInBytesPerSecond: null,
      netOutBytesPerSecond: null,
      t3: null,
      agents: { count: 4, cpuPercent: 120, memoryBytes: 1 },
      topCpu: null,
      topMemory: null,
    };
    expect(pointOf(sample)).toEqual({
      cpu: 33.3,
      cpuMax: 33.3,
      memory: 75,
      disk: 33.3,
      swap: 2.5,
      agents: 4,
      agentCpu: 120,
    });
    expect(pointOf({ ...sample, memoryTotalBytes: 0, agents: null })).toMatchObject({
      memory: null,
      agents: null,
    });
  });

  it("downsamples to the hour mean, keeps the CPU peak and skips missing values", () => {
    expect(
      averagePoints([
        point({ cpu: 10, cpuMax: 10, disk: null }),
        point({ cpu: 30, cpuMax: 95, disk: null }),
        point({ cpu: 20, cpuMax: 20, disk: 60 }),
      ]),
    ).toEqual({ cpu: 20, cpuMax: 95, memory: 50, disk: 60, swap: 0, agents: 2, agentCpu: 5 });
    expect(averagePoints([]).cpu).toBeNull();
  });
});

describe("thresholds (MM-1504)", () => {
  const hot = point({ cpu: 95 });

  it("CPU starts only after 5 minutes in a row above 90", () => {
    expect(resourceConditions(minutes(hot, hot, hot, hot), DEFAULT_HEALTH_THRESHOLDS).cpu).toBe(
      undefined,
    );
    expect(resourceConditions(minutes(hot, hot, hot, hot, hot), DEFAULT_HEALTH_THRESHOLDS)).toEqual(
      { cpu: { value: 95, threshold: 90 } },
    );
    // One calm minute or a missing minute breaks the run.
    expect(
      resourceConditions(minutes(hot, point(), hot, hot, hot, hot), DEFAULT_HEALTH_THRESHOLDS).cpu,
    ).toBe(undefined);
    const withGap = minutes(hot, hot, hot, hot, hot).filter((_, i) => i !== 2);
    expect(resourceConditions(withGap, DEFAULT_HEALTH_THRESHOLDS).cpu).toBe(undefined);
  });

  it("memory and disk start at once; swap needs its own run; null turns a check off", () => {
    const full = point({ memory: 93, disk: 97 });
    expect(resourceConditions(minutes(full), DEFAULT_HEALTH_THRESHOLDS)).toEqual({
      memory: { value: 93, threshold: 90 },
      disk: { value: 97, threshold: 90 },
    });
    const thrash = point({ swap: 40 });
    expect(
      resourceConditions(minutes(thrash, thrash, thrash, thrash, thrash), DEFAULT_HEALTH_THRESHOLDS)
        .swap,
    ).toEqual({ value: 40, threshold: 10 });
    expect(
      resourceConditions(minutes(full), { ...DEFAULT_HEALTH_THRESHOLDS, diskPercent: null }).disk,
    ).toBe(undefined);
    expect(resourceConditions([], DEFAULT_HEALTH_THRESHOLDS)).toEqual({});
  });

  it("a machine is down 15 minutes after it was last seen, and never when it never connected", () => {
    const seen: MachinePresence = {
      online: false,
      lastSeenAt: "2026-10-13T08:00:00.000Z",
      appliedRevision: null,
      status: null,
    };
    expect(offlineDueAt(seen, DEFAULT_HEALTH_THRESHOLDS)).toBe(T0 + 15 * MINUTE_MS);
    expect(offlineConditions(seen, DEFAULT_HEALTH_THRESHOLDS, T0 + 14 * MINUTE_MS)).toEqual({});
    expect(offlineConditions(seen, DEFAULT_HEALTH_THRESHOLDS, T0 + 16 * MINUTE_MS)).toEqual({
      offline: { value: 16, threshold: 15 },
    });
    expect(offlineDueAt({ ...seen, online: true }, DEFAULT_HEALTH_THRESHOLDS)).toBeNull();
    expect(offlineDueAt({ ...seen, lastSeenAt: null }, DEFAULT_HEALTH_THRESHOLDS)).toBeNull();
  });
});

describe("alert changes (MM-1505)", () => {
  it("starts new conditions, ends gone ones, and leaves other kinds alone", () => {
    const changes = alertChanges(
      [alert("cpu"), alert("offline")],
      { memory: { value: 93, threshold: 90 } },
      ["cpu", "memory", "disk", "swap"],
    );
    expect(changes.start).toEqual([{ kind: "memory", value: 93, threshold: 90 }]);
    expect(changes.end.map((a) => a.kind)).toEqual(["cpu"]);
  });

  it("does not start a second alert of a kind that is active", () => {
    const changes = alertChanges([alert("cpu")], { cpu: { value: 99, threshold: 90 } }, ["cpu"]);
    expect(changes).toEqual({ start: [], end: [] });
  });
});

describe("history (MM-1503)", () => {
  it("returns columns of the same length", () => {
    const history = historyOf(MAC, "hour", minutes(point({ cpu: 1 }), point({ cpu: 2 })));
    expect(history.at).toEqual([T0, T0 + MINUTE_MS]);
    expect(history.cpu).toEqual([1, 2]);
    expect(history.agents).toHaveLength(2);
    expect(history.stepMs).toBe(MINUTE_MS);
  });
});

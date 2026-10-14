/**
 * Pure rules of resources and health (MM-15xx): the stored point of a sample, the hourly average,
 * the retention, the alert checks and the history series. The Durable Object and the page share
 * this module.
 */
import type { MachineId, MachinePresence } from "@t3tools/contracts/machineMap";
import {
  DEFAULT_HEALTH_THRESHOLDS,
  type HealthAlert,
  type HealthAlertKind,
  type HealthThresholds,
  type ResourceHistory,
  type ResourceRange,
  type ResourceSample,
} from "@t3tools/contracts/machineMapResources";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** MM-1503: minute points stay 24 hours, hour points 30 days. */
export const MINUTE_RETENTION_MS = 24 * HOUR_MS;
export const HOUR_RETENTION_MS = 30 * 24 * HOUR_MS;
/** MM-1503: the size cap per machine, a little above what the retention keeps. */
export const MAX_MINUTE_POINTS = 1_500;
export const MAX_HOUR_POINTS = 750;
/** MM-1503: the portal refuses a bigger sample message. A normal one is under 2 KB. */
export const MAX_SAMPLE_MESSAGE_BYTES = 8_192;
/** MM-1505: ended alerts stay 30 days, at most this many. */
export const MAX_ENDED_ALERTS = 500;

export const RESOURCE_ALERT_KINDS: ReadonlyArray<HealthAlertKind> = [
  "cpu",
  "memory",
  "disk",
  "swap",
];

/** One stored step. Percent values, swap traffic in MB/s, and the agent process count. */
export interface ResourcePoint {
  readonly cpu: number | null;
  readonly cpuMax: number | null;
  /** CPU work without nice time, idle, I/O wait and steal. */
  readonly busy: number | null;
  /** CPU pressure, `some avg300`. */
  readonly pressure: number | null;
  readonly steal: number | null;
  readonly memory: number | null;
  readonly disk: number | null;
  readonly swap: number | null;
  readonly agents: number | null;
  readonly agentCpu: number | null;
}

export interface TimedPoint {
  readonly atMs: number;
  readonly point: ResourcePoint;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export const percentOf = (used: number | null, total: number | null): number | null =>
  used === null || total === null || total <= 0 ? null : round1((used / total) * 100);

export const minuteStart = (atMs: number) => atMs - (atMs % MINUTE_MS);
export const hourStart = (atMs: number) => atMs - (atMs % HOUR_MS);

export function pointOf(sample: ResourceSample): ResourcePoint {
  return {
    cpu: sample.cpuPercent,
    cpuMax: sample.cpuPercent,
    busy: sample.cpuBusyPercent,
    pressure: sample.cpuPressurePercent,
    steal: sample.cpuStealPercent,
    memory: percentOf(sample.memoryUsedBytes, sample.memoryTotalBytes),
    disk: percentOf(sample.diskUsedBytes, sample.diskTotalBytes),
    swap: sample.swapBytesPerSecond === null ? null : round1(sample.swapBytesPerSecond / 1_000_000),
    agents: sample.agents?.count ?? null,
    agentCpu: sample.agents?.cpuPercent ?? null,
  };
}

const POINT_KEYS = [
  "cpu",
  "busy",
  "pressure",
  "steal",
  "memory",
  "disk",
  "swap",
  "agents",
  "agentCpu",
] as const;

/** MM-1503: the hour point is the average of its minute points; `cpuMax` keeps the peak. */
export function averagePoints(points: ReadonlyArray<ResourcePoint>): ResourcePoint {
  const mean = (key: (typeof POINT_KEYS)[number]) => {
    const values = points.flatMap((p) => (p[key] === null ? [] : [p[key]]));
    return values.length === 0
      ? null
      : round1(values.reduce((sum, value) => sum + value, 0) / values.length);
  };
  const peaks = points.flatMap((p) => (p.cpuMax === null ? [] : [p.cpuMax]));
  return {
    cpu: mean("cpu"),
    cpuMax: peaks.length === 0 ? null : Math.max(...peaks),
    busy: mean("busy"),
    pressure: mean("pressure"),
    steal: mean("steal"),
    memory: mean("memory"),
    disk: mean("disk"),
    swap: mean("swap"),
    agents: mean("agents"),
    agentCpu: mean("agentCpu"),
  };
}

export const thresholdsFor = (
  stored: Readonly<Record<string, HealthThresholds>>,
  machineId: MachineId,
): HealthThresholds => stored[machineId] ?? DEFAULT_HEALTH_THRESHOLDS;

/** A condition that holds now, with the value that crossed the threshold. */
export interface Condition {
  readonly value: number;
  readonly threshold: number;
}
export type Conditions = Partial<Record<HealthAlertKind, Condition>>;

/**
 * The value of the newest point when the last `minutes` minute steps all exist and stay above
 * the threshold. A missing step breaks the run, so a gap never makes a sustained alert.
 */
function sustained(
  points: ReadonlyArray<TimedPoint>,
  pick: (point: ResourcePoint) => number | null,
  threshold: number,
  minutes: number,
): number | null {
  const newest = points.at(-1);
  if (newest === undefined) return null;
  const run = points.filter((p) => p.atMs > newest.atMs - minutes * MINUTE_MS);
  if (run.length < minutes) return null;
  const above = run.every((p) => {
    const value = pick(p.point);
    return value !== null && value > threshold;
  });
  return above ? pick(newest.point) : null;
}

/** MM-1504: the resource conditions of one machine. `points` are minute points, oldest first. */
export function resourceConditions(
  points: ReadonlyArray<TimedPoint>,
  thresholds: HealthThresholds,
): Conditions {
  const newest = points.at(-1)?.point;
  if (newest === undefined) return {};
  const conditions: Record<string, Condition> = {};
  const add = (kind: HealthAlertKind, value: number | null, threshold: number | null) => {
    if (value !== null && threshold !== null) conditions[kind] = { value, threshold };
  };
  // MM-1504: "starved" is CPU pressure where the machine reports it. Elsewhere it is CPU work
  // without nice time, so low priority builds never count. A point without the signal of the
  // newest point breaks the run.
  const cpu =
    newest.pressure !== null
      ? { pick: (p: ResourcePoint) => p.pressure, threshold: thresholds.cpuPressurePercent }
      : { pick: (p: ResourcePoint) => p.busy, threshold: thresholds.cpuPercent };
  if (cpu.threshold !== null) {
    add("cpu", sustained(points, cpu.pick, cpu.threshold, thresholds.cpuMinutes), cpu.threshold);
  }
  const instant = (value: number | null, threshold: number | null) =>
    value !== null && threshold !== null && value > threshold ? value : null;
  add("memory", instant(newest.memory, thresholds.memoryPercent), thresholds.memoryPercent);
  add("disk", instant(newest.disk, thresholds.diskPercent), thresholds.diskPercent);
  if (thresholds.swapMegabytesPerSecond !== null) {
    add(
      "swap",
      sustained(points, (p) => p.swap, thresholds.swapMegabytesPerSecond, thresholds.swapMinutes),
      thresholds.swapMegabytesPerSecond,
    );
  }
  return conditions;
}

/** MM-1504: when an offline machine counts as down, or null when it never will from here. */
export function offlineDueAt(
  presence: MachinePresence,
  thresholds: HealthThresholds,
): number | null {
  if (presence.online || presence.lastSeenAt === null || thresholds.offlineMinutes === null) {
    return null;
  }
  return Date.parse(presence.lastSeenAt) + thresholds.offlineMinutes * MINUTE_MS;
}

export function offlineConditions(
  presence: MachinePresence,
  thresholds: HealthThresholds,
  nowMs: number,
): Conditions {
  const due = offlineDueAt(presence, thresholds);
  if (due === null || nowMs < due || presence.lastSeenAt === null) return {};
  const minutes = Math.floor((nowMs - Date.parse(presence.lastSeenAt)) / MINUTE_MS);
  return { offline: { value: minutes, threshold: thresholds.offlineMinutes ?? 0 } };
}

export interface AlertChanges {
  readonly start: ReadonlyArray<{ readonly kind: HealthAlertKind } & Condition>;
  readonly end: ReadonlyArray<HealthAlert>;
}

/**
 * MM-1505: which alerts of one machine start and which end. Only the `kinds` that this check
 * covers change; the others stay as they are.
 */
export function alertChanges(
  active: ReadonlyArray<HealthAlert>,
  conditions: Conditions,
  kinds: ReadonlyArray<HealthAlertKind>,
): AlertChanges {
  const start: Array<{ readonly kind: HealthAlertKind } & Condition> = [];
  const end: Array<HealthAlert> = [];
  for (const kind of kinds) {
    const alert = active.find((a) => a.kind === kind && a.endedAt === null);
    const condition = conditions[kind];
    if (condition && !alert) start.push({ kind, ...condition });
    if (!condition && alert) end.push(alert);
  }
  return { start, end };
}

/** MM-1503: the step and span of each range. */
export const RANGE: Record<
  ResourceRange,
  { readonly step: "minute" | "hour"; readonly stepMs: number; readonly spanMs: number }
> = {
  hour: { step: "minute", stepMs: MINUTE_MS, spanMs: HOUR_MS },
  day: { step: "minute", stepMs: MINUTE_MS, spanMs: MINUTE_RETENTION_MS },
  month: { step: "hour", stepMs: HOUR_MS, spanMs: HOUR_RETENTION_MS },
};

/** MM-1503: stored points, oldest first, as columns. Missing steps stay missing. */
export function historyOf(
  machineId: MachineId,
  range: ResourceRange,
  points: ReadonlyArray<TimedPoint>,
): ResourceHistory {
  return {
    machineId,
    range,
    stepMs: RANGE[range].stepMs,
    at: points.map((p) => p.atMs),
    cpu: points.map((p) => p.point.cpu),
    cpuMax: points.map((p) => p.point.cpuMax),
    memory: points.map((p) => p.point.memory),
    disk: points.map((p) => p.point.disk),
    swap: points.map((p) => p.point.swap),
    agents: points.map((p) => p.point.agents),
    agentCpu: points.map((p) => p.point.agentCpu),
    pressure: points.map((p) => p.point.pressure),
    steal: points.map((p) => p.point.steal),
  };
}

/**
 * Fork: machine map resources and health (`apps/machine-map/SPEC.md`, MM-15xx). The T3 server
 * sends a resource sample to the portal every minute. The portal keeps the history, checks the
 * thresholds and records alerts.
 *
 * These messages ride on the same machine socket as `MachineToPortal` and `PortalToMachine`, but
 * stay out of those unions: an older portal and an older server fail to decode them and ignore
 * them, so old and new ends keep working together (MM-1502).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { MachineId, MapTime, type MapToolInputs } from "./machineMap.ts";

/** MM-1501: how many processes each top list holds. */
export const TOP_PROCESS_COUNT = 5;

const Percent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
const Bytes = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const Rate = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
/** A value that an older server does not send. It decodes as null, like a value the platform does not give. */
const NewerPercent = Schema.NullOr(Percent).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
);

/** One process in a top list. `name` is the executable name, at most 40 characters. */
export const ResourceProcess = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(40)),
  /** Average over the time since the previous sample. Null in the first sample. */
  cpuPercent: Schema.NullOr(Rate),
  memoryBytes: Bytes,
});
export type ResourceProcess = typeof ResourceProcess.Type;

const TopProcesses = Schema.NullOr(
  Schema.Array(ResourceProcess).check(Schema.isMaxLength(TOP_PROCESS_COUNT)),
);

/** The CPU and memory of a group of processes. CPU is in percent of one core, so it can pass 100. */
export const ProcessGroupUse = Schema.Struct({
  count: NonNegativeInt,
  cpuPercent: Rate,
  memoryBytes: Bytes,
});
export type ProcessGroupUse = typeof ProcessGroupUse.Type;

/**
 * MM-1501: one resource sample of a machine. A value that the platform does not give is null,
 * never a guess.
 */
export const ResourceSample = Schema.Struct({
  at: MapTime,
  /** The whole machine, 0 to 100. */
  cpuPercent: Schema.NullOr(Percent),
  /**
   * The whole machine since the previous sample, without nice time, idle, I/O wait and steal: the
   * work at normal priority. Null in the first sample.
   */
  cpuBusyPercent: NewerPercent,
  /** Time that the hypervisor gave to other guests since the previous sample. Linux only. */
  cpuStealPercent: NewerPercent,
  /**
   * CPU pressure: the share of time in the last 5 minutes that a task of the T3 server waited for
   * a CPU (`some avg300`). From the cgroup of the T3 server, or the whole machine when the cgroup
   * has no pressure file. Null where the kernel gives no pressure, for example macOS and Windows.
   */
  cpuPressurePercent: NewerPercent,
  cpuCount: Schema.NullOr(NonNegativeInt),
  /** Load averages over 1, 5 and 15 minutes. Null on Windows. */
  load: Schema.NullOr(Schema.Tuple([Rate, Rate, Rate])),
  memoryUsedBytes: Schema.NullOr(Bytes),
  memoryTotalBytes: Schema.NullOr(Bytes),
  swapUsedBytes: Schema.NullOr(Bytes),
  swapTotalBytes: Schema.NullOr(Bytes),
  /** Swap in plus swap out since the previous sample. Thrashing shows here. */
  swapBytesPerSecond: Schema.NullOr(Rate),
  /** The volume that holds the T3 home directory. */
  diskUsedBytes: Schema.NullOr(Bytes),
  diskTotalBytes: Schema.NullOr(Bytes),
  netInBytesPerSecond: Schema.NullOr(Rate),
  netOutBytesPerSecond: Schema.NullOr(Rate),
  /** The T3 server process itself. */
  t3: Schema.NullOr(Schema.Struct({ cpuPercent: Schema.NullOr(Rate), memoryBytes: Bytes })),
  /** Every process that the T3 server started: provider CLIs, agents, terminals and their children. */
  agents: Schema.NullOr(ProcessGroupUse),
  /** The busiest processes of the whole machine. */
  topCpu: TopProcesses,
  topMemory: TopProcesses,
});
export type ResourceSample = typeof ResourceSample.Type;

/** Machine to portal: one sample (MM-1501). */
export const MachineResourcesMessage = Schema.TaggedStruct("resources", { sample: ResourceSample });
export type MachineResourcesMessage = typeof MachineResourcesMessage.Type;

/** Portal to machine: send a sample now (MM-1501). */
export const PortalResourcesRequest = Schema.TaggedStruct("sampleResources", {});
export type PortalResourcesRequest = typeof PortalResourcesRequest.Type;

/** MM-1505: the kinds of alerts. Each one shows as one sticker on the machine card. */
export const HealthAlertKind = Schema.Literals(["cpu", "memory", "disk", "swap", "offline"]);
export type HealthAlertKind = typeof HealthAlertKind.Type;

const PositiveInt = NonNegativeInt.check(Schema.isGreaterThan(0));

/**
 * MM-1504: the thresholds of one machine. Null turns a check off. The CPU check means "the
 * machine is starved": CPU pressure above `cpuPressurePercent` where the machine reports it, else
 * CPU work without nice time above `cpuPercent`.
 */
export const HealthThresholds = Schema.Struct({
  /** Used only by a machine that reports no CPU pressure. */
  cpuPercent: Schema.NullOr(Percent),
  cpuPressurePercent: Schema.NullOr(Percent).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(20)),
  ),
  /** The CPU signal must stay above its threshold for this many minutes in a row. */
  cpuMinutes: PositiveInt,
  memoryPercent: Schema.NullOr(Percent),
  diskPercent: Schema.NullOr(Percent),
  /** Swap traffic in megabytes per second that counts as thrashing. */
  swapMegabytesPerSecond: Schema.NullOr(Rate),
  swapMinutes: PositiveInt,
  offlineMinutes: Schema.NullOr(PositiveInt),
});
export type HealthThresholds = typeof HealthThresholds.Type;

/** MM-1504. */
export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  cpuPercent: 95,
  cpuPressurePercent: 20,
  cpuMinutes: 30,
  memoryPercent: 90,
  diskPercent: 90,
  swapMegabytesPerSecond: 10,
  swapMinutes: 5,
  offlineMinutes: 15,
};

/** MM-1505: an alert. `endedAt` is null while it is active. */
export const HealthAlert = Schema.Struct({
  id: TrimmedNonEmptyString,
  machineId: MachineId,
  kind: HealthAlertKind,
  startedAt: MapTime,
  endedAt: Schema.NullOr(MapTime),
  /** The value that crossed the threshold at the start: percent, MB/s, or minutes offline. */
  value: Schema.Number,
  threshold: Schema.Number,
});
export type HealthAlert = typeof HealthAlert.Type;

export type ResourceRange = NonNullable<(typeof MapToolInputs.machines_resources.Type)["range"]>;
export const RESOURCE_RANGES = [
  "hour",
  "day",
  "month",
] as const satisfies ReadonlyArray<ResourceRange>;

/**
 * MM-1503: the history of one machine, one entry per step. The arrays have the same length.
 * Percent values, except `swap` in MB per second and `agents`, a process count.
 */
export const ResourceHistory = Schema.Struct({
  machineId: MachineId,
  range: Schema.Literals(RESOURCE_RANGES),
  stepMs: PositiveInt,
  /** Start of each step, in milliseconds since 1970. */
  at: Schema.Array(Schema.Number),
  cpu: Schema.Array(Schema.NullOr(Schema.Number)),
  cpuMax: Schema.Array(Schema.NullOr(Schema.Number)),
  memory: Schema.Array(Schema.NullOr(Schema.Number)),
  disk: Schema.Array(Schema.NullOr(Schema.Number)),
  swap: Schema.Array(Schema.NullOr(Schema.Number)),
  agents: Schema.Array(Schema.NullOr(Schema.Number)),
  agentCpu: Schema.Array(Schema.NullOr(Schema.Number)),
  /** CPU pressure and steal in percent. Empty from an older portal. */
  pressure: Schema.Array(Schema.NullOr(Schema.Number)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  steal: Schema.Array(Schema.NullOr(Schema.Number)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
});
export type ResourceHistory = typeof ResourceHistory.Type;

/** MM-1507: what `machines_read` adds about resources and health. */
export const ResourcesOverview = Schema.Struct({
  latest: Schema.Record(Schema.String, ResourceSample),
  alerts: Schema.Array(HealthAlert),
  thresholds: Schema.Record(Schema.String, HealthThresholds),
});
export type ResourcesOverview = typeof ResourcesOverview.Type;

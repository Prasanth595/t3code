// @effect-diagnostics nodeBuiltinImport:off - only node:perf_hooks exposes the event loop delay histogram, node:os the load average, and a synchronous procfs read the main thread's own counters.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePerfHooks from "node:perf_hooks";

import type { ServerEventLoopStall } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { RotatingFileSink } from "@t3tools/shared/logging";
import type { EffectTraceRecord } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as Metrics from "./Metrics.ts";

// Node's delay histogram wakes a native timer every RESOLUTION_MS and records the
// gap between wakeups, so an idle loop reads about RESOLUTION_MS and a stall of S
// reads between S and S + RESOLUTION_MS. We subtract the resolution, so a delay can
// undercount a stall by up to RESOLUTION_MS.
const RESOLUTION_MS = 1000;
const STALL_THRESHOLD_MS = 2000;
const SAMPLE_INTERVAL = "30 seconds";
// A line with candidates is about 1.5 KB. A host that stalls a few hundred times a
// day still keeps a day of them, one rotated file at most.
const STALL_LOG_MAX_BYTES = 1024 * 1024;
// Long enough that users felt it. Shorter stalls stay in the log only.
const NOTICEABLE_STALL_MS = 5000;
// Clients show what they get, so an old stall must not explain a new drop.
const NOTICEABLE_STALL_MAX_AGE_MS = 5 * 60_000;
// A span that blocked the loop for a stall lasted at least the stall, and stalls start
// above STALL_THRESHOLD_MS, so shorter spans can't be the cause.
export const SLOW_SPAN_MIN_MS = STALL_THRESHOLD_MS - RESOLUTION_MS;
// Long subscriptions and network calls also end up here. 128 holds a few sample
// windows of them on a busy host, so the span that blocked is still there at the tick.
const SLOW_SPAN_RING_SIZE = 128;
const STALL_CANDIDATE_LIMIT = 3;
const CANDIDATE_ATTRIBUTE_KEYS = [
  "rpc.method",
  "db.connection",
  "db.lock_wait_ms",
  "effect.sql.method",
  "db.query.text",
] as const;
const CANDIDATE_QUERY_MAX_CHARS = 200;

export interface SlowSpanRing {
  readonly record: (span: EffectTraceRecord) => void;
  readonly snapshot: () => ReadonlyArray<EffectTraceRecord>;
}

export const makeSlowSpanRing = (size = SLOW_SPAN_RING_SIZE): SlowSpanRing => {
  const spans: Array<EffectTraceRecord> = [];
  let next = 0;
  return {
    record: (span) => {
      spans[next] = span;
      next = (next + 1) % size;
    },
    snapshot: () => spans.slice(),
  };
};

/** Recently ended slow spans, fed by the server's tracer. Empty without one. */
export class RecentSlowSpans extends Context.Reference<SlowSpanRing>(
  "t3/observability/RecentSlowSpans",
  { defaultValue: () => ({ record: () => {}, snapshot: () => [] }) },
) {}

export class EventLoopMonitor extends Context.Reference<{
  /**
   * The latest stall of 5 s or more, if seen in the last 5 minutes. It samples
   * first, so a stall that ended just before a client reconnected is included.
   */
  readonly latestNoticeableStall: Effect.Effect<ServerEventLoopStall | undefined>;
}>("t3/observability/EventLoopMonitor", {
  defaultValue: () => ({ latestNoticeableStall: Effect.succeed(undefined) }),
}) {}

/** Delay in ns, active time in ms, CPU in µs. */
export interface EventLoopReadings {
  readonly delayMaxNs: number;
  readonly activeMs: number;
  readonly utilization: number;
  readonly usage: Pick<
    NodeJS.ResourceUsage,
    | "userCPUTime"
    | "systemCPUTime"
    | "majorPageFault"
    | "minorPageFault"
    | "involuntaryContextSwitches"
  >;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  /** Wall time the readings cover. */
  readonly elapsedMs: number;
  /** One-minute load average, undefined on Windows. */
  readonly loadAverage: number | undefined;
  readonly cpuCount: number;
  /** The main thread's own counters over the readings, Linux only. */
  readonly mainThread: MainThreadCounters | undefined;
}

/** CPU and runqueue time in ns, storage bytes the thread caused to be read. */
export interface MainThreadCounters {
  readonly cpuNs: number;
  readonly runqueueNs: number;
  readonly readBytes: number;
  readonly readSyscalls: number;
}

// process.resourceUsage() sums every thread, including the SQLite worker. A synchronous
// read of thread-self runs on the main thread, so it names that thread. Procfs files are
// generated in memory, never read from disk.
const readMainThreadCounters = (): MainThreadCounters | undefined => {
  try {
    const [cpuNs = Number.NaN, runqueueNs = Number.NaN] = NodeFS.readFileSync(
      "/proc/thread-self/schedstat",
      "utf8",
    )
      .trim()
      .split(" ")
      .map(Number);
    const io = NodeFS.readFileSync("/proc/thread-self/io", "utf8");
    const field = (name: string) => Number(new RegExp(`^${name}: (\\d+)$`, "m").exec(io)?.[1]);
    const counters = {
      cpuNs,
      runqueueNs,
      readBytes: field("read_bytes"),
      readSyscalls: field("syscr"),
    };
    return Object.values(counters).every(Number.isFinite) ? counters : undefined;
  } catch {
    return undefined;
  }
};

// Node skips the first gap after a reset, so a stall right at a sample boundary can be missed.
const makeNodeSampler = Effect.gen(function* () {
  const histogram = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: RESOLUTION_MS });
      histogram.enable();
      return histogram;
    }),
    (histogram) => Effect.sync(() => histogram.disable()),
  );
  let elu = NodePerfHooks.performance.eventLoopUtilization();
  let usage = process.resourceUsage();
  const readMainThread =
    (yield* HostProcess.Platform) === "linux" ? readMainThreadCounters : () => undefined;
  let mainThread = readMainThread();
  let sampledAt = NodePerfHooks.performance.now();

  // @effect-diagnostics-next-line returnEffectInGen:off - the read effect is the result.
  return Effect.sync(() => {
    const nextElu = NodePerfHooks.performance.eventLoopUtilization();
    const nextUsage = process.resourceUsage();
    const nextMainThread = readMainThread();
    const nextSampledAt = NodePerfHooks.performance.now();
    const memory = process.memoryUsage();
    const loop = NodePerfHooks.performance.eventLoopUtilization(nextElu, elu);
    const readings: EventLoopReadings = {
      delayMaxNs: histogram.max,
      activeMs: loop.active,
      utilization: loop.utilization,
      usage: {
        userCPUTime: nextUsage.userCPUTime - usage.userCPUTime,
        systemCPUTime: nextUsage.systemCPUTime - usage.systemCPUTime,
        majorPageFault: nextUsage.majorPageFault - usage.majorPageFault,
        minorPageFault: nextUsage.minorPageFault - usage.minorPageFault,
        involuntaryContextSwitches:
          nextUsage.involuntaryContextSwitches - usage.involuntaryContextSwitches,
      },
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      elapsedMs: nextSampledAt - sampledAt,
      // Windows has no load average and reports 0, which a running process never sees elsewhere.
      loadAverage: NodeOS.loadavg()[0] || undefined,
      cpuCount: NodeOS.availableParallelism(),
      mainThread:
        mainThread === undefined || nextMainThread === undefined
          ? undefined
          : {
              cpuNs: nextMainThread.cpuNs - mainThread.cpuNs,
              runqueueNs: nextMainThread.runqueueNs - mainThread.runqueueNs,
              readBytes: nextMainThread.readBytes - mainThread.readBytes,
              readSyscalls: nextMainThread.readSyscalls - mainThread.readSyscalls,
            },
    };
    histogram.reset();
    elu = nextElu;
    usage = nextUsage;
    mainThread = nextMainThread;
    sampledAt = nextSampledAt;
    return readings;
  });
});

export const stallMs = ({ delayMaxNs, activeMs }: EventLoopReadings) => {
  const delayMs = Math.round(delayMaxNs / 1e6) - RESOLUTION_MS;
  // libuv's clock keeps running while the system sleeps on macOS and Windows, so a
  // sleep also reads as delay, but the loop spent it idle in poll.
  if (delayMs <= STALL_THRESHOLD_MS || activeMs < delayMs) return undefined;
  return delayMs;
};

/**
 * Where the main thread's busy time went. The loop was active but the thread was
 * neither on a CPU nor waiting for one for `blockedMs`: it waited in the kernel, on a
 * disk read, a page fault, or a lock.
 */
export const mainThreadAttributes = ({ activeMs, mainThread }: EventLoopReadings) => {
  if (mainThread === undefined) return {};
  const cpuMs = Math.round(mainThread.cpuNs / 1e6);
  const runqueueMs = Math.round(mainThread.runqueueNs / 1e6);
  return {
    mainThreadCpuMs: cpuMs,
    mainThreadRunqueueMs: runqueueMs,
    mainThreadBlockedMs: Math.max(0, Math.round(activeMs) - cpuMs - runqueueMs),
    mainThreadReadMb: Math.round(mainThread.readBytes / 1024 / 1024),
    mainThreadReadSyscalls: mainThread.readSyscalls,
  };
};

const startMs = (span: EffectTraceRecord) => Number(BigInt(span.startTimeUnixNano) / 1_000_000n);
const endMs = (span: EffectTraceRecord) => Number(BigInt(span.endTimeUnixNano) / 1_000_000n);

/**
 * Spans that could have held the loop for this stall: they ran at least as long as it,
 * minus the histogram's resolution, and overlap the sampled window. The tightest
 * cover comes first, which is the innermost blocking span when the blocking code is
 * traced. These are candidates: a span that awaited I/O across the stall also matches.
 */
export const stallCandidates = (
  spans: ReadonlyArray<EffectTraceRecord>,
  window: { readonly startMs: number; readonly endMs: number },
  stallMs: number,
) =>
  spans
    .filter(
      (span) =>
        span.durationMs >= stallMs - RESOLUTION_MS &&
        startMs(span) <= window.endMs &&
        endMs(span) >= window.startMs,
    )
    .toSorted((left, right) => left.durationMs - right.durationMs)
    .slice(0, STALL_CANDIDATE_LIMIT)
    .map((span) => {
      const attributes: Record<string, unknown> = {};
      for (const key of CANDIDATE_ATTRIBUTE_KEYS) {
        const value = span.attributes[key];
        if (value === undefined) continue;
        attributes[key] =
          typeof value === "string" ? value.slice(0, CANDIDATE_QUERY_MAX_CHARS) : value;
      }
      return {
        name: span.name,
        durationMs: Math.round(span.durationMs),
        startedAt: DateTime.formatIso(DateTime.makeUnsafe(startMs(span))),
        traceId: span.traceId,
        spanId: span.spanId,
        attributes,
      };
    });

// Untraced: it runs inside every 30-second tick, which already has the monitor's own span.
const recordGauges = Effect.fnUntraced(function* (readings: EventLoopReadings) {
  const cpuMs = (readings.usage.userCPUTime + readings.usage.systemCPUTime) / 1000;
  yield* Metric.update(Metrics.serverResidentBytes, readings.rssBytes);
  yield* Metric.update(Metrics.serverHeapUsedBytes, readings.heapUsedBytes);
  yield* Metric.update(Metrics.serverEventLoopUtilization, readings.utilization);
  yield* Metric.update(
    Metrics.serverEventLoopDelayMax,
    Math.max(0, Math.round(readings.delayMaxNs / 1e6) - RESOLUTION_MS),
  );
  if (readings.elapsedMs > 0) {
    yield* Metric.update(Metrics.serverCpuUtilization, cpuMs / readings.elapsedMs);
  }
});

const encodeStallLine = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export interface StallLogOptions {
  readonly filePath: string;
  readonly maxBytes: number;
}

const layerWith = (
  makeSampler: Effect.Effect<Effect.Effect<EventLoopReadings>, never, Scope.Scope>,
  stallLog: StallLogOptions,
) =>
  Layer.effect(
    EventLoopMonitor,
    Effect.gen(function* () {
      const sample = yield* makeSampler;
      const slowSpans = yield* RecentSlowSpans;
      // Clients sample on connect as well as the timer, and the sampler resets shared state.
      const sampling = yield* Semaphore.make(1);
      const warmedUp = yield* Ref.make(false);
      const latestNoticeableStall = yield* Ref.make<
        { readonly stall: ServerEventLoopStall; readonly detectedAtMs: number } | undefined
      >(undefined);
      const stallSink = yield* Effect.try(
        () =>
          new RotatingFileSink({
            filePath: stallLog.filePath,
            maxBytes: stallLog.maxBytes,
            maxFiles: 1,
            throwOnError: true,
          }),
      ).pipe(
        Effect.catch(() =>
          Effect.logWarning("event loop stall log unavailable", {
            filePath: stallLog.filePath,
          }).pipe(Effect.as(undefined)),
        ),
      );
      const tick = Effect.gen(function* () {
        const readings = yield* sample;
        yield* recordGauges(readings);
        const delayMaxMs = stallMs(readings);
        if (delayMaxMs === undefined) return;
        const { utilization, usage, rssBytes, loadAverage, cpuCount, elapsedMs } = readings;
        const now = yield* DateTime.now;
        const detectedAt = DateTime.formatIso(now);
        const windowEndMs = DateTime.toEpochMillis(now);
        const windowStartMs = windowEndMs - Math.round(elapsedMs);
        if (delayMaxMs >= NOTICEABLE_STALL_MS) {
          yield* Ref.set(latestNoticeableStall, {
            detectedAtMs: DateTime.toEpochMillis(now),
            stall: {
              detectedAt,
              durationMs: delayMaxMs,
              ...(loadAverage === undefined
                ? {}
                : { loadAverage: Math.round(loadAverage * 10) / 10 }),
              cpuCount,
            },
          });
        }
        const attributes = {
          delayMaxMs,
          utilization: Math.round(utilization * 100) / 100,
          cpuUserMs: Math.round(usage.userCPUTime / 1000),
          cpuSystemMs: Math.round(usage.systemCPUTime / 1000),
          majorPageFaults: usage.majorPageFault,
          minorPageFaults: usage.minorPageFault,
          involuntaryContextSwitches: usage.involuntaryContextSwitches,
          rssMb: Math.round(rssBytes / 1024 / 1024),
          // The stall happened somewhere in this window; the sample only knows its length.
          windowStartedAt: DateTime.formatIso(DateTime.makeUnsafe(windowStartMs)),
          ...mainThreadAttributes(readings),
          candidates: stallCandidates(
            slowSpans.snapshot(),
            { startMs: windowStartMs, endMs: windowEndMs },
            delayMaxMs,
          ),
        };
        yield* Effect.logWarning(`event loop stalled for ${delayMaxMs} ms`, attributes).pipe(
          Effect.withSpan("server.eventLoop.stall", { root: true, level: "Warn", attributes }),
        );
        if (stallSink !== undefined) {
          yield* encodeStallLine({ time: detectedAt, ...attributes }).pipe(
            Effect.flatMap((line) => Effect.try(() => stallSink.write(`${line}\n`))),
            Effect.catch(() =>
              Effect.logWarning("event loop stall log write failed", {
                filePath: stallLog.filePath,
              }),
            ),
          );
        }
      }).pipe(sampling.withPermits(1));
      const wait = Effect.sleep(SAMPLE_INTERVAL);
      // The layer builds before the rest of the server, so the first sample covers
      // startup work such as migrations and projection bootstrap. That can block the
      // loop for seconds on a large database, so skip it rather than warn at every
      // launch.
      yield* wait.pipe(
        Effect.andThen(sampling.withPermits(1)(sample)),
        Effect.andThen(Ref.set(warmedUp, true)),
        Effect.andThen(wait.pipe(Effect.andThen(tick), Effect.forever)),
        Effect.forkScoped,
      );

      return EventLoopMonitor.of({
        latestNoticeableStall: Effect.gen(function* () {
          if (yield* Ref.get(warmedUp)) yield* tick;
          const latest = yield* Ref.get(latestNoticeableStall);
          if (latest === undefined) return undefined;
          const ageMs = DateTime.toEpochMillis(yield* DateTime.now) - latest.detectedAtMs;
          return ageMs <= NOTICEABLE_STALL_MAX_AGE_MS ? latest.stall : undefined;
        }),
      });
    }),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { serverTracePath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerWith(makeNodeSampler, {
      filePath: path.join(path.dirname(serverTracePath), "event-loop-stalls.ndjson"),
      maxBytes: STALL_LOG_MAX_BYTES,
    });
  }),
);

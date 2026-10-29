// @effect-diagnostics nodeBuiltinImport:off - only node:perf_hooks tells a blocked loop from a sleeping machine, and node:process and node:os tell a busy loop from a starved one.
// @effect-diagnostics globalTimers:off - the detector must run on the loop it measures, outside any fiber.
import * as NodeOS from "node:os";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeProcess from "node:process";

export interface Stall {
  /** How long the loop was late, beyond one tick interval. */
  readonly stallMs: number;
  /** The gap the loop could not run in, on the detector's clock. */
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  /** CPU the loop's thread (or, without `threadCpuUsage`, the whole process) used in the window. */
  readonly cpuMs: number;
  readonly cpuSource: UsageReading["cpuSource"];
  /** Major page faults in the window: pages the process waited on the disk for. */
  readonly majorPageFaults: number;
  /** The 1-minute load average when the stall was seen. */
  readonly load1: number;
}

/** Cumulative counters, read on every tick; a stall reports their change over its window. */
export interface UsageReading {
  readonly cpuMicros: number;
  readonly cpuSource: "thread" | "process";
  readonly majorPageFaults: number;
}

// Node 22 has no threadCpuUsage; process.cpuUsage also counts worker threads.
const threadCpuUsage = (
  NodeProcess as { readonly threadCpuUsage?: () => NodeJS.CpuUsage }
).threadCpuUsage?.bind(NodeProcess);

const readUsage = (): UsageReading => {
  const cpu = threadCpuUsage?.() ?? NodeProcess.cpuUsage();
  return {
    cpuMicros: cpu.user + cpu.system,
    cpuSource: threadCpuUsage === undefined ? "process" : "thread",
    majorPageFaults: NodeProcess.resourceUsage().majorPageFault,
  };
};

export interface StallDetectorOptions {
  readonly intervalMs: number;
  readonly thresholdMs: number;
  readonly onStall: (stall: Stall) => void;
  readonly now?: () => number;
  /** Ignore gaps in which the loop was mostly idle (sleep). Default true. */
  readonly checkUtilization?: boolean;
  /** Tests inject these; the defaults read the process and the OS. */
  readonly readUsage?: () => UsageReading;
  readonly readLoad1?: () => number;
}

/**
 * Ticks on an unref'd timer and reports each gap longer than `thresholdMs`. Returns stop.
 * A gap in which the loop was mostly idle (the machine slept) is not a stall.
 */
export const startStallDetector = (options: StallDetectorOptions): (() => void) => {
  const now = options.now ?? (() => performance.now());
  let lastTickMs = now();
  const usageNow = options.readUsage ?? readUsage;
  const load1 = options.readLoad1 ?? (() => Math.round((NodeOS.loadavg()[0] ?? 0) * 100) / 100);
  let lastElu = NodePerfHooks.performance.eventLoopUtilization();
  let lastUsage = usageNow();
  const timer = setInterval(() => {
    const tickMs = now();
    const elu = NodePerfHooks.performance.eventLoopUtilization();
    const stallMs = Math.round(tickMs - lastTickMs - options.intervalMs);
    const activeMs = NodePerfHooks.performance.eventLoopUtilization(elu, lastElu).active;
    const usage = usageNow();
    const windowStartMs = lastTickMs;
    const windowUsage = lastUsage;
    lastTickMs = tickMs;
    lastElu = elu;
    lastUsage = usage;
    if (stallMs <= options.thresholdMs) return;
    if (options.checkUtilization !== false && activeMs < stallMs / 2) return;
    try {
      options.onStall({
        stallMs,
        windowStartMs,
        windowEndMs: tickMs,
        cpuMs: Math.round((usage.cpuMicros - windowUsage.cpuMicros) / 1000),
        cpuSource: usage.cpuSource,
        majorPageFaults: usage.majorPageFaults - windowUsage.majorPageFaults,
        load1: load1(),
      });
    } catch {
      // A reporting failure must not stop detection.
    }
  }, options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};

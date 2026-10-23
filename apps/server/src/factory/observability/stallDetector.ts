// @effect-diagnostics nodeBuiltinImport:off - only node:perf_hooks tells a blocked loop from a sleeping machine.
// @effect-diagnostics globalTimers:off - the detector must run on the loop it measures, outside any fiber.
import * as NodePerfHooks from "node:perf_hooks";

export interface Stall {
  /** How long the loop was late, beyond one tick interval. */
  readonly stallMs: number;
  /** The gap the loop could not run in, on the detector's clock. */
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

export interface StallDetectorOptions {
  readonly intervalMs: number;
  readonly thresholdMs: number;
  readonly onStall: (stall: Stall) => void;
  readonly now?: () => number;
  /** Ignore gaps in which the loop was mostly idle (sleep). Default true. */
  readonly checkUtilization?: boolean;
}

/**
 * Ticks on an unref'd timer and reports each gap longer than `thresholdMs`. Returns stop.
 * A gap in which the loop was mostly idle (the machine slept) is not a stall.
 */
export const startStallDetector = (options: StallDetectorOptions): (() => void) => {
  const now = options.now ?? (() => performance.now());
  let lastTickMs = now();
  let lastElu = NodePerfHooks.performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const tickMs = now();
    const elu = NodePerfHooks.performance.eventLoopUtilization();
    const stallMs = Math.round(tickMs - lastTickMs - options.intervalMs);
    const activeMs = NodePerfHooks.performance.eventLoopUtilization(elu, lastElu).active;
    const windowStartMs = lastTickMs;
    lastTickMs = tickMs;
    lastElu = elu;
    if (stallMs <= options.thresholdMs) return;
    if (options.checkUtilization !== false && activeMs < stallMs / 2) return;
    try {
      options.onStall({ stallMs, windowStartMs, windowEndMs: tickMs });
    } catch {
      // A reporting failure must not stop detection.
    }
  }, options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};

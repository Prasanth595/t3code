import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startStallDetector, type Stall } from "./stallDetector.ts";

/** Blocks this thread for `ms` without reading a clock. */
const blockThread = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

afterEach(() => {
  vi.useRealTimers();
});

describe("startStallDetector", () => {
  it("reports a real synchronous block longer than the threshold, with the window it covered", async () => {
    let stop = () => {};
    try {
      const stall = await new Promise<Stall>((resolve) => {
        stop = startStallDetector({ intervalMs: 10, thresholdMs: 100, onStall: resolve });
        blockThread(250);
      });
      expect(stall.stallMs).toBeGreaterThanOrEqual(200);
      expect(stall.windowEndMs - stall.windowStartMs).toBeGreaterThanOrEqual(250);
    } finally {
      stop();
    }
  });

  it("reports the gap as the window between two ticks, beyond one interval", () => {
    vi.useFakeTimers();
    let now = 1000;
    const stalls: Array<Stall> = [];
    const stop = startStallDetector({
      intervalMs: 250,
      thresholdMs: 2000,
      now: () => now,
      checkUtilization: false,
      onStall: (stall) => stalls.push(stall),
    });
    now += 250;
    vi.advanceTimersByTime(250);
    now += 5250;
    vi.advanceTimersByTime(250);
    stop();
    expect(stalls).toEqual([{ stallMs: 5000, windowStartMs: 1250, windowEndMs: 6500 }]);
  });

  it("stays quiet for a gap at or below the threshold", () => {
    vi.useFakeTimers();
    let now = 0;
    const stalls: Array<Stall> = [];
    const stop = startStallDetector({
      intervalMs: 250,
      thresholdMs: 2000,
      now: () => now,
      checkUtilization: false,
      onStall: (stall) => stalls.push(stall),
    });
    now += 2250;
    vi.advanceTimersByTime(250);
    stop();
    expect(stalls).toEqual([]);
  });

  it("ignores a gap in which the loop was idle, as when the machine sleeps", () => {
    vi.useFakeTimers();
    let now = 0;
    const stalls: Array<Stall> = [];
    const stop = startStallDetector({
      intervalMs: 250,
      thresholdMs: 2000,
      now: () => now,
      onStall: (stall) => stalls.push(stall),
    });
    // The fake clock jumps, but no real time passed, so the loop was not busy.
    now += 60_000;
    vi.advanceTimersByTime(250);
    stop();
    expect(stalls).toEqual([]);
  });

  it("stops reporting after stop()", () => {
    vi.useFakeTimers();
    let now = 0;
    const stalls: Array<Stall> = [];
    const stop = startStallDetector({
      intervalMs: 250,
      thresholdMs: 2000,
      now: () => now,
      checkUtilization: false,
      onStall: (stall) => stalls.push(stall),
    });
    stop();
    now += 10_000;
    vi.advanceTimersByTime(1000);
    expect(stalls).toEqual([]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { startStallDetector, type Stall } from "./stallDetector.ts";

const busyWait = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Blocks the loop on purpose.
  }
};

describe("startStallDetector", () => {
  it("reports a synchronous block longer than the threshold, with the window it covered", async () => {
    const stalls: Array<Stall> = [];
    const stop = startStallDetector({
      intervalMs: 10,
      thresholdMs: 100,
      onStall: (stall) => stalls.push(stall),
    });
    try {
      const blockedAt = performance.now();
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          busyWait(250);
          resolve();
        }, 30),
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(stalls).toHaveLength(1);
      const [stall] = stalls;
      expect(stall!.stallMs).toBeGreaterThanOrEqual(200);
      expect(stall!.windowStartMs).toBeGreaterThanOrEqual(blockedAt - 1);
      expect(stall!.windowEndMs - stall!.windowStartMs).toBeGreaterThanOrEqual(250);
    } finally {
      stop();
    }
  });

  it("stays quiet when the loop is only busy for less than the threshold", async () => {
    const stalls: Array<Stall> = [];
    const stop = startStallDetector({
      intervalMs: 10,
      thresholdMs: 200,
      onStall: (stall) => stalls.push(stall),
    });
    try {
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          busyWait(50);
          resolve();
        }, 20),
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(stalls).toEqual([]);
    } finally {
      stop();
    }
  });

  it("stops reporting after stop()", async () => {
    const stalls: Array<Stall> = [];
    const stop = startStallDetector({
      intervalMs: 10,
      thresholdMs: 50,
      onStall: (stall) => stalls.push(stall),
    });
    stop();
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        busyWait(120);
        resolve();
      }, 20),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stalls).toEqual([]);
  });
});

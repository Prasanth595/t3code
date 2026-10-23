import { assert, describe, it } from "@effect/vitest";
import type { EffectTraceRecord } from "@t3tools/shared/observability";

import * as EventLoopMonitor from "./EventLoopMonitor.ts";

const ms = (value: number) => value * 1e6;

// Node reports a stall of S as a gap of up to S + 1 s, the histogram resolution.
const stalled: EventLoopMonitor.EventLoopReadings = {
  delayMaxNs: ms(5_950),
  activeMs: 6_200,
  utilization: 0.176,
  usage: {
    userCPUTime: 310_400,
    systemCPUTime: 95_600,
    majorPageFault: 8_412,
    minorPageFault: 20_031,
    involuntaryContextSwitches: 57,
  },
  rssBytes: 1536 * 1024 * 1024,
  heapUsedBytes: 512 * 1024 * 1024,
  elapsedMs: 30_000,
  loadAverage: 219.43,
  cpuCount: 18,
  mainThread: {
    cpuNs: ms(900),
    runqueueNs: ms(100),
    readBytes: 512 * 1024 * 1024,
    readSyscalls: 61_000,
  },
};

const windowStartMs = Date.UTC(2026, 9, 23, 14, 6, 17);
const windowEndMs = windowStartMs + 30_000;
const span = (
  name: string,
  startOffsetMs: number,
  durationMs: number,
  attributes: Record<string, unknown> = {},
): EffectTraceRecord => ({
  type: "effect-span",
  name,
  kind: "internal",
  traceId: `trace-${name}`,
  spanId: `span-${name}`,
  sampled: true,
  startTimeUnixNano: String(BigInt(windowStartMs + startOffsetMs) * 1_000_000n),
  endTimeUnixNano: String(BigInt(windowStartMs + startOffsetMs + durationMs) * 1_000_000n),
  durationMs,
  attributes,
  events: [],
  links: [],
  exit: { _tag: "Success" },
});

describe("EventLoopMonitor", () => {
  it("ignores delay the loop spent idle, such as a system sleep", () => {
    // Waking from sleep reads as a long gap, but the loop was idle in poll for it.
    const asleep: EventLoopMonitor.EventLoopReadings = {
      ...stalled,
      delayMaxNs: ms(600_000),
      activeMs: 900,
    };
    assert.isUndefined(EventLoopMonitor.stallMs(asleep));
    assert.strictEqual(EventLoopMonitor.stallMs({ ...asleep, activeMs: 600_000 }), 599_000);
  });

  it("counts busy time the main thread spent off a CPU as blocked", () => {
    // 6.2 s active, 0.9 s on a CPU and 0.1 s runnable leaves 5.2 s waiting in the kernel.
    assert.deepStrictEqual(EventLoopMonitor.mainThreadAttributes(stalled), {
      mainThreadCpuMs: 900,
      mainThreadRunqueueMs: 100,
      mainThreadBlockedMs: 5_200,
      mainThreadReadMb: 512,
      mainThreadReadSyscalls: 61_000,
    });
    assert.deepStrictEqual(
      EventLoopMonitor.mainThreadAttributes({ ...stalled, mainThread: undefined }),
      {},
    );
  });

  it("ranks the tightest span that covered a stall first", () => {
    const query = `SELECT ${"x, ".repeat(100)}y FROM projection_threads`;
    const spans = [
      span("ws.rpc.subscribeThread", -3_600_000, 3_620_000),
      span("ws.rpc.orchestration.getShell", 9_000, 6_300, { "rpc.method": "getShell" }),
      span("sqlite", 9_100, 6_100, { "db.connection": "reader", "db.query.text": query }),
      span("GitHubPullRequestApi.getPullRequestSummary", 2_000, 1_500),
      span("ProjectionStore.getThread", 40_000, 7_000),
    ];
    const candidates = EventLoopMonitor.stallCandidates(
      spans,
      { startMs: windowStartMs, endMs: windowEndMs },
      5_950,
    );
    assert.deepStrictEqual(
      candidates.map((candidate) => candidate.name),
      ["sqlite", "ws.rpc.orchestration.getShell", "ws.rpc.subscribeThread"],
    );
    assert.strictEqual(candidates[0]?.attributes["db.connection"], "reader");
    assert.strictEqual(String(candidates[0]?.attributes["db.query.text"]).length, 200);
    assert.strictEqual(candidates[0]?.startedAt, "2026-10-23T14:06:26.100Z");
  });

  it("keeps only the newest slow spans", () => {
    const ring = EventLoopMonitor.makeSlowSpanRing(2);
    for (const name of ["a", "b", "c"]) ring.record(span(name, 0, 2_000));
    assert.deepStrictEqual(
      ring
        .snapshot()
        .map((record) => record.name)
        .toSorted(),
      ["b", "c"],
    );
  });
});

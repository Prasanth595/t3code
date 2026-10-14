import { describe, expect, it } from "vite-plus/test";
import { MachineId } from "@t3tools/contracts/machineMap";

import { historyOf, MINUTE_MS, type ResourcePoint } from "../rules/health.ts";
import { chartLines, countMax, withLivePoint, type ChartFrame } from "./chart.ts";

const T0 = Date.parse("2026-10-13T08:00:00.000Z");
const frame: ChartFrame = {
  startMs: T0,
  endMs: T0 + 10 * MINUTE_MS,
  width: 100,
  height: 50,
  max: 100,
};
const at = (minutes: ReadonlyArray<number>) => minutes.map((m) => T0 + m * MINUTE_MS);

const point = (cpu: number): ResourcePoint => ({
  cpu,
  cpuMax: cpu,
  busy: null,
  pressure: null,
  steal: null,
  memory: null,
  disk: null,
  swap: null,
  agents: null,
  agentCpu: null,
});

describe("chartLines (MM-1508)", () => {
  it("draws one line through steady points, scaled to the frame", () => {
    expect(chartLines(at([0, 1, 2]), [0, 50, 200], MINUTE_MS, frame)).toEqual(["0,50 10,25 20,0"]);
  });

  it("breaks the line at a missing value and at an offline gap", () => {
    expect(
      chartLines(at([0, 1, 2, 3, 6, 7]), [10, null, 10, 10, 10, 10], MINUTE_MS, frame),
    ).toEqual(["0,45 1.5,45", "20,45 30,45", "60,45 70,45"]);
  });

  it("skips points outside the frame", () => {
    expect(chartLines(at([-5, 1]), [10, 10], MINUTE_MS, frame)).toEqual(["10,45 11.5,45"]);
  });

  it("gives a count chart room above its top value", () => {
    expect(countMax([null, 0])).toBe(1);
    expect(countMax([3, 8, null])).toBe(10);
  });
});

describe("withLivePoint (MM-1508)", () => {
  it("replaces the point of the same minute and drops old points", () => {
    const history = historyOf(MachineId.make("mac"), "hour", [
      { atMs: T0, point: point(1) },
      { atMs: T0 + MINUTE_MS, point: point(2) },
      { atMs: T0 + 2 * MINUTE_MS, point: point(3) },
    ]);
    const live = withLivePoint(history, T0 + 2 * MINUTE_MS + 30_000, point(9), MINUTE_MS);
    expect(live.at).toEqual([T0 + MINUTE_MS, T0 + 2 * MINUTE_MS]);
    expect(live.cpu).toEqual([2, 9]);
    expect(live.agents).toHaveLength(2);
  });
});

/**
 * MM-1508: a tiny chart helper. It turns a time series into SVG polyline points. The portal draws
 * a chart only when a sample arrives, so it needs no chart library and no animation.
 */
import type { ResourceHistory } from "@t3tools/contracts/machineMapResources";

import { minuteStart, type ResourcePoint } from "../rules/health.ts";

export interface ChartFrame {
  readonly startMs: number;
  readonly endMs: number;
  readonly width: number;
  readonly height: number;
  /** The value at the top edge. Higher values stay at the top edge. */
  readonly max: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

export const chartY = (value: number, frame: ChartFrame): number =>
  round2(frame.height - (Math.min(Math.max(value, 0), frame.max) / frame.max) * frame.height);

/**
 * The `points` attribute of each line. A missing value, or a gap of more than one and a half
 * steps (the machine was offline), starts a new line. A lone point becomes a short dash.
 */
export function chartLines(
  at: ReadonlyArray<number>,
  values: ReadonlyArray<number | null>,
  stepMs: number,
  frame: ChartFrame,
): Array<string> {
  const span = frame.endMs - frame.startMs;
  if (span <= 0 || frame.max <= 0) return [];
  const lines: Array<string> = [];
  let current: Array<{ x: number; y: number }> = [];
  let lastAt: number | null = null;
  const flush = () => {
    const [only] = current;
    if (current.length === 1 && only)
      lines.push(`${only.x},${only.y} ${round2(only.x + 1.5)},${only.y}`);
    else if (current.length > 1) lines.push(current.map((p) => `${p.x},${p.y}`).join(" "));
    current = [];
  };
  at.forEach((atMs, i) => {
    const value = values[i];
    if (value === null || value === undefined || atMs < frame.startMs || atMs > frame.endMs) {
      flush();
      lastAt = null;
      return;
    }
    if (lastAt !== null && atMs - lastAt > stepMs * 1.5) flush();
    current.push({
      x: round2(((atMs - frame.startMs) / span) * frame.width),
      y: chartY(value, frame),
    });
    lastAt = atMs;
  });
  flush();
  return lines;
}

/** A top value for a count chart: a little room above the highest value, at least 1. */
export function countMax(values: ReadonlyArray<number | null>): number {
  const highest = Math.max(0, ...values.flatMap((v) => (v === null ? [] : [v])));
  return Math.max(1, Math.ceil(highest * 1.25));
}

/**
 * A live sample as the newest minute point of an hour or day history, so a chart moves on
 * between fetches. Points older than `spanMs` drop off.
 */
export function withLivePoint(
  history: ResourceHistory,
  atMs: number,
  point: ResourcePoint,
  spanMs: number,
): ResourceHistory {
  const minute = minuteStart(atMs);
  const keep = history.at.flatMap((t, i) => (t >= minute - spanMs && t < minute ? [i] : []));
  const pick = <T>(column: ReadonlyArray<T>, value: T): Array<T> => [
    ...keep.flatMap((i) => (i < column.length ? [column[i] as T] : [])),
    value,
  ];
  return {
    ...history,
    at: pick(history.at, minute),
    cpu: pick(history.cpu, point.cpu),
    cpuMax: pick(history.cpuMax, point.cpuMax),
    memory: pick(history.memory, point.memory),
    disk: pick(history.disk, point.disk),
    swap: pick(history.swap, point.swap),
    agents: pick(history.agents, point.agents),
    agentCpu: pick(history.agentCpu, point.agentCpu),
  };
}

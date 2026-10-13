/**
 * MM-1503, MM-1505: the SQLite tables of resources and health in the Durable Object: minute and
 * hour points, the latest sample of each machine, and alerts. The rules live in `rules/health.ts`.
 */
import * as Schema from "effect/Schema";
import type { MachineId } from "@t3tools/contracts/machineMap";
import { HealthAlert, ResourceSample } from "@t3tools/contracts/machineMapResources";

import {
  averagePoints,
  HOUR_RETENTION_MS,
  hourStart,
  MAX_ENDED_ALERTS,
  MAX_HOUR_POINTS,
  MAX_MINUTE_POINTS,
  MINUTE_RETENTION_MS,
  minuteStart,
  pointOf,
  type TimedPoint,
} from "./rules/health.ts";

type SqlValue = string | number | null;

/**
 * The SQL that the store needs. The Durable Object passes `ctx.storage.sql`; the tests pass an
 * in-memory `node:sqlite` database.
 */
export interface SqlRunner {
  run<T extends Record<string, SqlValue>>(query: string, ...bindings: Array<SqlValue>): Array<T>;
  transaction(work: () => void): void;
}

const ResourcePoint = Schema.Struct({
  cpu: Schema.NullOr(Schema.Number),
  cpuMax: Schema.NullOr(Schema.Number),
  memory: Schema.NullOr(Schema.Number),
  disk: Schema.NullOr(Schema.Number),
  swap: Schema.NullOr(Schema.Number),
  agents: Schema.NullOr(Schema.Number),
  agentCpu: Schema.NullOr(Schema.Number),
});

const decodeJson = <T>(schema: Schema.ConstraintDecoder<T>) => {
  const decode = Schema.decodeUnknownSync(schema);
  return (text: string): T => decode(JSON.parse(text));
};
const decodePoint = decodeJson(ResourcePoint);
const decodeSample = decodeJson(ResourceSample);
const decodeAlert = decodeJson(HealthAlert);

const STEP_CODE = { minute: "m", hour: "h" } as const;

export const HEALTH_TABLES = `
  CREATE TABLE IF NOT EXISTS resource_points (machine_id TEXT NOT NULL, step TEXT NOT NULL, at_ms INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (machine_id, step, at_ms));
  CREATE TABLE IF NOT EXISTS resource_latest (machine_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS health_alerts (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, active INTEGER NOT NULL, started_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS health_alerts_by_start ON health_alerts (started_at);
`;

export class HealthStore {
  readonly #sql: SqlRunner;

  constructor(sql: SqlRunner) {
    this.#sql = sql;
  }

  /**
   * MM-1503: one minute point per machine and minute, and the average of the hour so far as its
   * hour point. A second sample in the same minute replaces the first.
   */
  record(machineId: MachineId, sample: ResourceSample, nowMs: number): void {
    const hour = hourStart(nowMs);
    this.#sql.transaction(() => {
      this.#sql.run(
        "INSERT OR REPLACE INTO resource_points (machine_id, step, at_ms, data) VALUES (?, 'm', ?, ?)",
        machineId,
        minuteStart(nowMs),
        JSON.stringify(pointOf(sample)),
      );
      const minutes = this.points(machineId, "minute", hour).map((p) => p.point);
      this.#sql.run(
        "INSERT OR REPLACE INTO resource_points (machine_id, step, at_ms, data) VALUES (?, 'h', ?, ?)",
        machineId,
        hour,
        JSON.stringify(averagePoints(minutes)),
      );
      this.#sql.run(
        "INSERT OR REPLACE INTO resource_latest (machine_id, data) VALUES (?, ?)",
        machineId,
        JSON.stringify(sample),
      );
    });
  }

  /** Points of one machine from `fromMs` on, oldest first. */
  points(machineId: MachineId, step: "minute" | "hour", fromMs: number): Array<TimedPoint> {
    return this.#sql
      .run<{ at_ms: number; data: string }>(
        "SELECT at_ms, data FROM resource_points WHERE machine_id = ? AND step = ? AND at_ms >= ? ORDER BY at_ms",
        machineId,
        STEP_CODE[step],
        fromMs,
      )
      .map((row) => ({ atMs: row.at_ms, point: decodePoint(row.data) }));
  }

  hasPoints(): boolean {
    return this.#sql.run("SELECT 1 AS one FROM resource_points LIMIT 1").length > 0;
  }

  /** The latest sample of each machine in `machineIds`. */
  latest(machineIds: ReadonlySet<string>): Record<string, ResourceSample> {
    return Object.fromEntries(
      this.#sql
        .run<{ machine_id: string; data: string }>("SELECT machine_id, data FROM resource_latest")
        .filter((row) => machineIds.has(row.machine_id))
        .map((row) => [row.machine_id, decodeSample(row.data)]),
    );
  }

  /** The active alerts, newest first, then up to `ended` ended ones. */
  alerts(ended: number): Array<HealthAlert> {
    const active = this.#sql
      .run<{ data: string }>("SELECT data FROM health_alerts WHERE active = 1 ORDER BY started_at DESC")
      .map((row) => decodeAlert(row.data));
    if (ended === 0) return active;
    const done = this.#sql
      .run<{ data: string }>(
        "SELECT data FROM health_alerts WHERE active = 0 ORDER BY started_at DESC LIMIT ?",
        ended,
      )
      .map((row) => decodeAlert(row.data));
    return [...active, ...done];
  }

  /** The alerts of one machine that are active or started at `since` or later. */
  alertsOf(machineId: MachineId, since: string): Array<HealthAlert> {
    return this.#sql
      .run<{ data: string }>(
        "SELECT data FROM health_alerts WHERE machine_id = ? AND (active = 1 OR started_at >= ?) ORDER BY started_at DESC",
        machineId,
        since,
      )
      .map((row) => decodeAlert(row.data));
  }

  saveAlert(alert: HealthAlert): void {
    this.#sql.run(
      "INSERT OR REPLACE INTO health_alerts (id, machine_id, active, started_at, data) VALUES (?, ?, ?, ?, ?)",
      alert.id,
      alert.machineId,
      alert.endedAt === null ? 1 : 0,
      alert.startedAt,
      JSON.stringify(alert),
    );
  }

  /**
   * MM-1503, MM-1505: drops points past their retention or over the size cap of each machine,
   * and ended alerts past 30 days or over their cap. Active alerts stay.
   */
  prune(nowMs: number, machineIds: ReadonlyArray<string>): void {
    this.#sql.transaction(() => {
      this.#sql.run(
        "DELETE FROM resource_points WHERE (step = 'm' AND at_ms < ?) OR (step = 'h' AND at_ms < ?)",
        nowMs - MINUTE_RETENTION_MS,
        nowMs - HOUR_RETENTION_MS,
      );
      for (const machineId of machineIds) {
        for (const [step, cap] of [
          ["m", MAX_MINUTE_POINTS],
          ["h", MAX_HOUR_POINTS],
        ] as const) {
          this.#sql.run(
            `DELETE FROM resource_points WHERE machine_id = ? AND step = ? AND at_ms NOT IN
               (SELECT at_ms FROM resource_points WHERE machine_id = ? AND step = ? ORDER BY at_ms DESC LIMIT ?)`,
            machineId,
            step,
            machineId,
            step,
            cap,
          );
        }
      }
      this.#sql.run(
        "DELETE FROM health_alerts WHERE active = 0 AND started_at < ?",
        new Date(nowMs - HOUR_RETENTION_MS).toISOString(),
      );
      this.#sql.run(
        `DELETE FROM health_alerts WHERE active = 0 AND id NOT IN
           (SELECT id FROM health_alerts WHERE active = 0 ORDER BY started_at DESC LIMIT ?)`,
        MAX_ENDED_ALERTS,
      );
    });
  }

  /** MM-208: a removed machine leaves no resource rows behind. */
  removeMachine(machineId: MachineId): void {
    this.#sql.transaction(() => {
      for (const table of ["resource_points", "resource_latest", "health_alerts"]) {
        this.#sql.run(`DELETE FROM ${table} WHERE machine_id = ?`, machineId);
      }
    });
  }
}

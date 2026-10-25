import * as Effect from "effect/Effect";
import type * as Cloudflare from "@cloudflare/workers-types";
import type { Summary } from "./Summary.ts";

interface Totals {
  developer: string;
  host: string;
  platform: string;
  arch: string;
  ci: number;
  local_ms: number;
  unspecified_ms: number;
  unspecified_hits: number;
  remote_ms: number;
  local_hits: number;
  remote_hits: number;
  executed: number;
  restore_failures: number;
}

export const persistSavings = Effect.fn("TaskCache.persistSavings")(function* (
  database: Cloudflare.D1Database,
  summary: typeof Summary.Type,
  developer: string,
) {
  const local = summary.tasks.filter((task) => task.source === "local");
  const unspecified = summary.tasks.filter((task) => task.source === "unspecified");
  const remote = summary.tasks.filter((task) => task.source === "remote");
  // D1 batch is transactional. changes() gates the increment on the preceding receipt insertion.
  yield* Effect.tryPromise(() =>
    database.batch([
      database
        .prepare("INSERT INTO receipts(id, recorded_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
        .bind(summary.id, summary.recordedAt),
      database
        .prepare(`INSERT INTO savings(developer, host, platform, arch, ci, local_ms, remote_ms, local_hits, remote_hits, executed, restore_failures, unspecified_ms, unspecified_hits) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1
      ON CONFLICT DO UPDATE SET
        local_ms = local_ms + excluded.local_ms, remote_ms = remote_ms + excluded.remote_ms,
        local_hits = local_hits + excluded.local_hits, remote_hits = remote_hits + excluded.remote_hits,
        executed = executed + excluded.executed, restore_failures = restore_failures + excluded.restore_failures,
        unspecified_ms = unspecified_ms + excluded.unspecified_ms, unspecified_hits = unspecified_hits + excluded.unspecified_hits`)
        .bind(
          developer,
          summary.host,
          summary.platform,
          summary.arch,
          Number(summary.ci),
          local.reduce((sum, task) => sum + task.savedMs, 0),
          remote.reduce((sum, task) => sum + task.savedMs, 0),
          local.length,
          remote.length,
          summary.tasks.filter((task) => task.source === "executed").length,
          summary.tasks.filter((task) => task.source === "failed").length,
          unspecified.reduce((sum, task) => sum + task.savedMs, 0),
          unspecified.length,
        ),
    ]),
  );
});

export const emitTotals = Effect.fn("TaskCache.emitTotals")(function* (
  database: Cloudflare.D1Database,
  developer?: string,
  host?: string,
) {
  const rows = yield* Effect.tryPromise(() =>
    (developer === undefined
      ? database.prepare("SELECT * FROM savings")
      : database
          .prepare("SELECT * FROM savings WHERE developer = ? AND host = ?")
          .bind(developer, host)
    ).all<Totals>(),
  );
  yield* Effect.forEach(rows.results, (row) =>
    Effect.annotateCurrentSpan({
      "developer.id": row.developer,
      "host.name": row.host,
      "host.os": row.platform,
      "host.arch": row.arch,
      ci: Boolean(row.ci),
      "cache.local_saved_ms": row.local_ms,
      "cache.unspecified_saved_ms": row.unspecified_ms,
      "cache.unspecified_hits": row.unspecified_hits,
      "cache.remote_saved_ms": row.remote_ms,
      "cache.local_hits": row.local_hits,
      "cache.remote_hits": row.remote_hits,
      "cache.executed": row.executed,
      "cache.restore_failures": row.restore_failures,
    }).pipe(Effect.withSpan("TaskCache.lifetime")),
  );
});

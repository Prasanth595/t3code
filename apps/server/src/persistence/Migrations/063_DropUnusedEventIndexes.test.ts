import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("063_DropUnusedEventIndexes", (it) => {
  it.effect("drops the event indexes no read uses and keeps the ones reads need", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* runMigrations({ toMigrationInclusive: 63 });

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'orchestration_events'
      `;
      const indexes = new Set(rows.map((row) => row.name));

      for (const removed of ["idx_orch_events_correlation_id", "idx_orch_events_stream_sequence"]) {
        assert.isFalse(indexes.has(removed), removed);
      }
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_command_id",
        "idx_orchestration_events_application_sequence",
        "idx_orchestration_events_application_high_water",
        "idx_orchestration_events_agent_stream_sequence",
        "orchestration_events_v2_created_threads_idx",
      ]) {
        assert.isTrue(indexes.has(kept), kept);
      }
    }),
  );
});

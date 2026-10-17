import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("063_DropUnreadV1Projections", (it) => {
  it.effect("drops the V1 tables nothing reads and keeps the importer's sources", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at
        ) VALUES ('thread-1', 'project-1', 'V1 thread', '{}', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('message-1', 'thread-1', 'user', 'hello', 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES ('activity-1', 'thread-1', NULL, 'tool', 'tool.completed', 'Ran a tool', '{}', 1,
          '2026-01-01T00:00:00.000Z')
      `;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 63 }), [
        [63, "DropUnreadV1Projections"],
      ]);

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      const tables = new Set(rows.map((row) => row.name));
      for (const dropped of [
        "projection_thread_activities",
        "projection_turns",
        "projection_thread_proposed_plans",
        "projection_pending_approvals",
        "projection_state",
        "checkpoint_diff_blobs",
      ]) {
        assert.isFalse(tables.has(dropped), dropped);
      }
      for (const kept of [
        "projection_threads",
        "projection_thread_messages",
        "projection_thread_pull_requests",
        "projection_thread_sessions",
        "projection_projects",
      ]) {
        assert.isTrue(tables.has(kept), kept);
      }
      assert.deepStrictEqual(yield* sql`SELECT message_id, text FROM projection_thread_messages`, [
        { message_id: "message-1", text: "hello" },
      ]);
    }),
  );
});

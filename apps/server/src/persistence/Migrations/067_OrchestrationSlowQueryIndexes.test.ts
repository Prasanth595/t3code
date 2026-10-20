import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("067_OrchestrationSlowQueryIndexes", (it) => {
  it.effect("creates the indexes and the planner uses them for the slow queries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, ordinal, type, status, payload_json, updated_at
        ) VALUES (
          'item-1', 'thread-1', NULL, 1, 'user_message', 'completed',
          '{"messageId":"message-1"}', '2026-01-01'
        )
      `;
      const beforeMessages = yield* sql`
        SELECT json_extract(payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = 'thread-1' AND type IN ('user_message', 'assistant_message')
        GROUP BY json_extract(payload_json, '$.messageId')
      `;
      const beforeRunning = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id FROM orchestration_v2_projection_runs WHERE status = 'running'
      `;
      assert.isFalse(
        beforeRunning.some((row) => row.detail.includes("runs_recovery_idx")),
        beforeRunning.map((row) => row.detail).join("\n"),
      );
      yield* runMigrations({ toMigrationInclusive: 67 });
      assert.deepEqual(yield* runMigrations(), []);

      const afterRunning = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id FROM orchestration_v2_projection_runs WHERE status = 'running'
      `;
      assert.isTrue(
        afterRunning.some((row) => row.detail.includes("runs_running_idx")),
        afterRunning.map((row) => row.detail).join("\n"),
      );
      const recoveryPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id FROM orchestration_v2_projection_runs
        WHERE thread_id = 'thread-1'
          AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      `;
      assert.isTrue(
        recoveryPlan.some((row) => row.detail.includes("runs_recovery_idx")),
        recoveryPlan.map((row) => row.detail).join("\n"),
      );

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index'
      `;
      const indexes = new Set(rows.map((row) => row.name));
      for (const name of [
        "orchestration_v2_projection_turn_items_thread_type_idx",
        "orchestration_v2_projection_turn_items_thread_message_idx",
        "orchestration_v2_projection_turn_items_run_status_idx",
        "orchestration_v2_projection_runs_running_idx",
        "orchestration_v2_projection_runs_user_message_idx",
        "orchestration_v2_projection_provider_turns_thread_completed_idx",
        "idx_orchestration_events_aggregate_version_sequence",
      ]) {
        assert.isTrue(indexes.has(name), name);
      }

      const afterMessages = yield* sql`
        SELECT json_extract(payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = 'thread-1' AND type IN ('user_message', 'assistant_message')
        GROUP BY json_extract(payload_json, '$.messageId')
      `;
      assert.deepEqual(afterMessages, beforeMessages);
      const messagePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT json_extract(payload_json, '$.messageId'), MIN(ordinal)
        FROM orchestration_v2_projection_turn_items
        WHERE thread_id = 'thread-1' AND type IN ('user_message', 'assistant_message')
        GROUP BY json_extract(payload_json, '$.messageId')
      `;
      assert.isTrue(
        messagePlan.some((row) =>
          row.detail.includes("orchestration_v2_projection_turn_items_thread_message_idx"),
        ),
        messagePlan.map((row) => row.detail).join("\n"),
      );

      const runPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id FROM orchestration_v2_projection_runs
        WHERE json_extract(payload_json, '$.userMessageId') = 'message-1'
      `;
      assert.isTrue(
        runPlan.some((row) =>
          row.detail.includes("orchestration_v2_projection_runs_user_message_idx"),
        ),
        runPlan.map((row) => row.detail).join("\n"),
      );
    }),
  );
});

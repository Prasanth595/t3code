import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect.each([null, "root"])("seeks ordered root errors when node is %s", (nodeId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 61 });
    yield* sql`
          WITH RECURSIVE items(ordinal) AS (
            SELECT 1 UNION ALL SELECT ordinal + 1 FROM items WHERE ordinal < 512
          )
          INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id, thread_id, run_id, node_id, ordinal, type, status, updated_at, payload_json)
          SELECT 'command-' || ordinal, 'thread', 'run', ${nodeId}, ordinal,
            'command_execution', 'completed', '2026-10-01', '{}'
          FROM items
        `;
    yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id, thread_id, run_id, node_id, ordinal, type, status, updated_at, payload_json)
          VALUES
            ('older', 'thread', 'run', ${nodeId}, 513, 'error', 'failed', '2026-10-02', '{}'),
            ('tie-a', 'thread', 'run', ${nodeId}, 514, 'error', 'failed', '2026-10-02', '{}'),
            ('tie-b', 'thread', 'run', ${nodeId}, 514, 'error', 'failed', '2026-10-02', '{}'),
            ('child', 'thread', 'run', 'child', 515, 'error', 'failed', '2026-10-03', '{}'),
            ('other-run', 'thread', 'other', ${nodeId}, 516, 'error', 'failed', '2026-10-03', '{}')
        `;
    yield* runMigrations({ toMigrationInclusive: 62 });
    const lookup = sql<{ readonly turn_item_id: string }>`
          SELECT turn_item_id FROM orchestration_v2_projection_turn_items
          WHERE thread_id = 'thread' AND run_id = 'run'
            AND node_id IS ${nodeId} AND type = 'error' AND status = 'failed'
          ORDER BY updated_at DESC, ordinal DESC, turn_item_id DESC LIMIT 1
        `;
    assert.deepEqual(yield* lookup, [{ turn_item_id: "tie-b" }]);
    const [query, parameters] = lookup.compile();
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${query}`,
      parameters,
    );
    assert.isTrue(plan.some((row) => row.detail.includes("turn_items_failed_error_idx")));
    assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));

    yield* sql`
          UPDATE orchestration_v2_projection_turn_items SET status = 'completed'
          WHERE turn_item_id = 'tie-b'
        `;
    assert.deepEqual(yield* lookup, [{ turn_item_id: "tie-a" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

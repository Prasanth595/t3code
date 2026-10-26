import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("070_CommunicationProjection", (it) => {
  it.effect("backfills verified envelopes and rejects provenance changes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });
      const envelope = {
        schemaVersion: 2,
        classification: "verified",
        id: "message-1",
        threadId: "thread-1",
        route: { port: "internal.in", audience: "coordinator" },
        producer: { kind: "agent", id: "agent-1" },
        recipientId: "thread-1",
        kind: "delegation.result",
        correlationId: "request-1",
        delivery: { state: "accepted" },
      };
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES
          ('message-1', 'thread-1', NULL, NULL, 'user', 0,
           '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z',
           ${JSON.stringify({ role: "user", communication: envelope })}),
          ('message-old', 'thread-1', NULL, NULL, 'assistant', 0,
           '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z', '{}')
      `;
      yield* runMigrations();
      const rows = yield* sql<{ readonly port: string; readonly delivery_state: string }>`
        SELECT port, delivery_state FROM orchestration_v2_projection_communications
      `;
      assert.deepEqual(rows, [{ port: "internal.in", delivery_state: "accepted" }]);

      yield* sql`
        UPDATE orchestration_v2_projection_communications
        SET delivery_state = 'offered',
            envelope_json = ${JSON.stringify({ ...envelope, delivery: { state: "offered" } })}
        WHERE message_id = 'message-1'
      `;
      const changedProvenance = yield* Effect.exit(sql`
        UPDATE orchestration_v2_projection_communications
        SET envelope_json = ${JSON.stringify({ ...envelope, producer: { kind: "human", id: "user-1" } })}
        WHERE message_id = 'message-1'
      `);
      assert.equal(changedProvenance._tag, "Failure");
      const erased = yield* Effect.exit(sql`
        UPDATE orchestration_v2_projection_messages
        SET payload_json = '{}'
        WHERE message_id = 'message-1'
      `);
      assert.equal(erased._tag, "Failure");
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'message-1'`;
      const remaining = yield* sql`
        SELECT message_id FROM orchestration_v2_projection_communications
      `;
      assert.deepEqual(remaining, []);
    }),
  );
});

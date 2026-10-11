import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE orchestration_command_receipts ADD COLUMN intent_fingerprint TEXT`;
  yield* sql`CREATE TABLE orchestration_v2_projection_swarms (
    swarm_id TEXT PRIMARY KEY, owner_thread_id TEXT NOT NULL, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX orchestration_v2_projection_swarms_owner_idx ON orchestration_v2_projection_swarms(owner_thread_id)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_swarm_members (
    thread_id TEXT PRIMARY KEY, swarm_id TEXT NOT NULL
  ) WITHOUT ROWID`;
});

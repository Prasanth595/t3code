import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_claude_database_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), generation TEXT NOT NULL UNIQUE)`;
  yield* sql`CREATE TABLE orchestration_v2_claude_sessions (
    thread_id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, physical_store TEXT NOT NULL,
    native_id TEXT NOT NULL, physical_transcript TEXT NOT NULL, revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(environment_id, physical_store, native_id),
    UNIQUE(environment_id, physical_transcript)
  )`;
  yield* sql`CREATE TABLE orchestration_v2_claude_operations (
    operation_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX orchestration_v2_claude_operations_thread_idx ON orchestration_v2_claude_operations(thread_id)`;
  yield* sql`CREATE TABLE orchestration_v2_claude_history (
    thread_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, boundary_sequence INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE orchestration_v2_claude_generations (
    generation_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    state TEXT NOT NULL, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX orchestration_v2_claude_generations_thread_idx ON orchestration_v2_claude_generations(thread_id, state)`;
  yield* sql`CREATE TABLE orchestration_v2_claude_writes (
    write_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    state TEXT NOT NULL, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX orchestration_v2_claude_writes_thread_idx ON orchestration_v2_claude_writes(thread_id, state)`;
});

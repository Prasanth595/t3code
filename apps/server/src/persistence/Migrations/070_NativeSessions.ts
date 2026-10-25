import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_native_history (thread_id TEXT NOT NULL, native_turn_id TEXT NOT NULL, native_item_id TEXT NOT NULL, message_id TEXT, turn_item_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(thread_id, native_turn_id, native_item_id))`;
  yield* sql`CREATE TABLE orchestration_v2_native_sessions (thread_id TEXT PRIMARY KEY, native_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX orchestration_v2_native_sessions_native_id_idx ON orchestration_v2_native_sessions(json_extract(payload_json, '$.binding.nativeId'))`;
  yield* sql`CREATE TABLE orchestration_v2_native_operations (operation_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX orchestration_v2_native_operations_thread_idx ON orchestration_v2_native_operations(thread_id)`;
  yield* sql`CREATE TABLE orchestration_v2_native_effects (effect_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX orchestration_v2_native_effects_thread_state_idx ON orchestration_v2_native_effects(thread_id, state)`;
});

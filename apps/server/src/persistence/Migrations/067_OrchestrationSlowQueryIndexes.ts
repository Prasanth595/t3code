import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Each expression index repeats the json_extract text of the query it serves.
// SQLite only uses an expression index when the query expression matches it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_thread_type_idx
    ON orchestration_v2_projection_turn_items(thread_id, type)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_thread_message_idx
    ON orchestration_v2_projection_turn_items(thread_id, json_extract(payload_json, '$.messageId'))
    WHERE type IN ('user_message', 'assistant_message')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_run_status_idx
    ON orchestration_v2_projection_turn_items(run_id, status)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_running_idx
    ON orchestration_v2_projection_runs(thread_id)
    WHERE status = 'running'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_runs_user_message_idx
    ON orchestration_v2_projection_runs(json_extract(payload_json, '$.userMessageId'))
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_turns_thread_completed_idx
    ON orchestration_v2_projection_provider_turns(thread_id, completed_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_events_aggregate_version_sequence
    ON orchestration_events(aggregate_kind, application_event_version, sequence)
  `;
});

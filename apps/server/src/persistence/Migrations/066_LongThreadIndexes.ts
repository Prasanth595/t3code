import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Partial predicates must match the snapshot and recovery queries so SQLite
// can seek live rows without traversing completed history.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_delegated_delivery_idx
    ON orchestration_v2_projection_runs(thread_id)
    WHERE CASE WHEN json_valid(payload_json)
      THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
      ELSE 0 END
  `;

  yield* sql`
    CREATE INDEX orchestration_v2_projection_run_attempts_live_idx
    ON orchestration_v2_projection_run_attempts(thread_id)
    WHERE status IN ('pending','starting','running','waiting')
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_provider_turns_live_idx
    ON orchestration_v2_projection_provider_turns(thread_id)
    WHERE status IN ('starting','running','waiting')
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_provider_turns_node_idx
    ON orchestration_v2_projection_provider_turns(node_id)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_checkpoints_live_idx
    ON orchestration_v2_projection_checkpoints(thread_id)
    WHERE status IN ('pending','capturing')
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_checkpoints_run_idx
    ON orchestration_v2_projection_checkpoints(run_id)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_checkpoints_node_idx
    ON orchestration_v2_projection_checkpoints(node_id)
  `;
});

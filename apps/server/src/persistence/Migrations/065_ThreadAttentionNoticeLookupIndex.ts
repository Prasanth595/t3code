import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_attention_notice_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE type = 'system_notice' AND json_extract(payload_json, '$.needsAttention') = 1
  `;
});

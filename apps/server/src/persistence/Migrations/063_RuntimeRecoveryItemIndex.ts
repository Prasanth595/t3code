import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Recovery looks up unfinished work across item types. The existing recovery
  // index covers only three types, so these reads walk the finished transcript.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_live_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE status IN ('pending', 'running', 'waiting')
  `;
});

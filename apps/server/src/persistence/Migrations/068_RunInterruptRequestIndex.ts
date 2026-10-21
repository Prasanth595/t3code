import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The thread shell checks every thread's latest run for a stop request.
  // Without this, that check reads each item row of the run to test its type.
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_run_interrupt_idx
    ON orchestration_v2_projection_turn_items(thread_id, run_id)
    WHERE type = 'run_interrupt_request'
  `;
});

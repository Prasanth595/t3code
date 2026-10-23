import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Replace the narrower index so SQLite cannot choose it and seek every payload
  // just to filter status. The original ordering prefix remains unchanged.
  yield* sql`DROP INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal, turn_item_id, status)
  `;
});

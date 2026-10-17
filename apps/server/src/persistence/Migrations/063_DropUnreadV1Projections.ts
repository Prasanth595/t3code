import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The V2 database starts as a copy of V1. The legacy importer reads only V1
  // threads, messages and pull request links, so these tables are dead weight.
  yield* sql`DROP TABLE IF EXISTS projection_thread_activities`;
  yield* sql`DROP TABLE IF EXISTS projection_turns`;
  yield* sql`DROP TABLE IF EXISTS projection_thread_proposed_plans`;
  yield* sql`DROP TABLE IF EXISTS projection_pending_approvals`;
  yield* sql`DROP TABLE IF EXISTS projection_state`;
  yield* sql`DROP TABLE IF EXISTS checkpoint_diff_blobs`;
});

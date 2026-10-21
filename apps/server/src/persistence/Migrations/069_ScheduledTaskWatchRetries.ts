import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_task_watch_events ADD COLUMN dispatch_command_id TEXT`;
  yield* sql`ALTER TABLE scheduled_task_watch_events ADD COLUMN dispatch_order INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE INDEX scheduled_task_watch_events_order ON scheduled_task_watch_events(dispatch_order)`;
});

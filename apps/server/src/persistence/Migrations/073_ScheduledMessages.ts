import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE scheduled_messages (
      message_id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      send_at TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      workspace_strategy_json TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      created_by TEXT NOT NULL,
      creation_source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      sent_thread_id TEXT
    )
  `;

  yield* sql`
    CREATE INDEX scheduled_messages_due
    ON scheduled_messages(status, send_at)
  `;
});

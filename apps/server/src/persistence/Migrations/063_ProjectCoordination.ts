import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE coordination_entries (
    entry_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
    topic TEXT NOT NULL, sender_thread_id TEXT, target_thread_id TEXT, reply_to_id TEXT,
    kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX coordination_entries_project_revision ON coordination_entries(project_id, revision DESC)`;
  yield* sql`CREATE INDEX coordination_entries_request ON coordination_entries(project_id, sender_thread_id, target_thread_id, topic, status, reply_to_id)`;
  yield* sql`CREATE INDEX coordination_entries_replies ON coordination_entries(reply_to_id, revision)`;
  yield* sql`CREATE TABLE coordination_changes (
    revision INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL,
    entry_id TEXT, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX coordination_changes_project ON coordination_changes(project_id, revision)`;
  yield* sql`CREATE TABLE coordination_receipts (
    command_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX coordination_receipts_project ON coordination_receipts(project_id)`;
  yield* sql`CREATE TABLE coordination_attachments (
    attachment_id TEXT NOT NULL, project_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY (attachment_id, project_id)
  )`;
  yield* sql`CREATE INDEX coordination_attachments_project ON coordination_attachments(project_id)`;
  yield* sql`CREATE TABLE coordination_preferences (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL
  )`;
});

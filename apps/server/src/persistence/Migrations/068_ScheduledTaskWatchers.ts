import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN watch_json TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN watch_revision TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN watch_secret_name TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN watch_initialized_at TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN watch_last_fired_at TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN watch_fire_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TABLE scheduled_task_watch_snapshot (
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(task_id) ON DELETE CASCADE,
    item_key TEXT NOT NULL,
    matched INTEGER NOT NULL,
    PRIMARY KEY (task_id, item_key)
  )`;
  yield* sql`CREATE TABLE scheduled_task_watch_events (
    event_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    created_at TEXT NOT NULL,
    prompt TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    thread_id TEXT,
    run_id TEXT
  )`;
  yield* sql`CREATE INDEX scheduled_task_watch_events_task_state
    ON scheduled_task_watch_events(task_id, state)`;
});

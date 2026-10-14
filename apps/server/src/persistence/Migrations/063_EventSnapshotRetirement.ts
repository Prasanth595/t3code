import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The first and latest stored snapshot of each node, message and turn item.
  // Every snapshot between them is deleted, so the sink needs both to know
  // which row a new snapshot supersedes.
  yield* sql`
    CREATE TABLE orchestration_v2_event_snapshot_heads (
      event_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      first_sequence INTEGER NOT NULL,
      last_sequence INTEGER NOT NULL,
      PRIMARY KEY (event_type, entity_id)
    ) WITHOUT ROWID
  `;
  // Snapshots stored before this migration have no heads. A background pass
  // retires them one thread at a time, up to the sequence recorded here, and
  // deletes the row when it finishes.
  yield* sql`
    CREATE TABLE orchestration_v2_event_snapshot_backfill (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      through_sequence INTEGER NOT NULL,
      after_thread_id TEXT NOT NULL
    )
  `;
  // Only this bare form reads one page. Wrapped in HAVING or a subquery, MAX
  // scans an index of every event: seconds on a large database.
  const latest = yield* sql<{ readonly sequence: number | null }>`
    SELECT MAX(sequence) AS sequence FROM orchestration_events
  `;
  const throughSequence = latest[0]?.sequence ?? null;
  if (throughSequence !== null) {
    yield* sql`
      INSERT INTO orchestration_v2_event_snapshot_backfill (id, through_sequence, after_thread_id)
      VALUES (1, ${throughSequence}, '')
    `;
  }
});

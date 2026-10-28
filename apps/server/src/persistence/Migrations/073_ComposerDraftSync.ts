import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE composer_drafts (
      draft_key TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      deleted INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX composer_drafts_updated_at
    ON composer_drafts(updated_at)
  `;
});

import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * The messages search indexes: finished, and either written by the user or
 * answered by an agent. User-role notices that agents or the system wrote
 * stay out. Subagent threads stay out too: search never shows them, and ACP
 * subagents rewrite their whole finished answer on every streamed chunk.
 * Migrations 69 and 71's triggers, 69's backfill, the rebuild, and the scan use
 * it; `row` names the message row (a table alias, or `new` in a trigger).
 */
export const indexedMessageCondition = (sql: SqlClient.SqlClient, row = "messages") =>
  sql.literal(`
  ${row}.streaming = 0
  AND (
    ${row}.role = 'assistant'
    OR (
      ${row}.role = 'user'
      AND COALESCE(json_extract(${row}.payload_json, '$.createdBy'), 'user') = 'user'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_threads AS subagent_threads
    WHERE subagent_threads.thread_id = ${row}.thread_id
      AND json_extract(subagent_threads.payload_json, '$.lineage.relationshipToParent') = 'subagent'
  )
`);

// Curly apostrophes straight, as search folds a query, since iOS keyboards
// type "’" and others type "'".
const foldApostrophes = (text: string) => `replace(replace(${text}, '’', ''''), '‘', '''')`;

/**
 * What migration 69 indexed for a message: its stored text with apostrophes
 * folded. Its triggers and backfill run before messages have search_text, so
 * they keep this. `payload` is the message's JSON column.
 */
export const indexedMessageText = (sql: SqlClient.SqlClient, payload: string) =>
  sql.literal(foldApostrophes(`json_extract(${payload}, '$.text')`));

/**
 * What the index stores for a message since migration 71: its text as it
 * reads, so a quote's words match instead of their percent-encoded link,
 * with apostrophes folded. Migration 71's triggers and the rebuild use it;
 * `row` names the message row (a table alias, or `new` in a trigger).
 */
export const indexedSearchText = (sql: SqlClient.SqlClient, row = "messages") =>
  sql.literal(
    foldApostrophes(`COALESCE(${row}.search_text, json_extract(${row}.payload_json, '$.text'))`),
  );

/**
 * Refills the search index from the messages table. The index is keyed by
 * message rowid, so anything that may renumber or copy rows (VACUUM, a dev
 * database copy) rebuilds it instead of trusting it. Databases from before
 * migration 69, or on an SQLite without FTS5 trigrams, have no index.
 */
export const rebuildMessageSearch = Effect.fn("MessageSearchIndex.rebuild")(function* (
  sql: SqlClient.SqlClient,
) {
  const index = yield* sql`
    SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'
  `;
  if (index.length === 0) return;
  // A database from before migration 71 has no search_text yet.
  const readable = yield* sql`
    SELECT 1 FROM pragma_table_info('orchestration_v2_projection_messages')
    WHERE name = 'search_text'
  `;
  const text =
    readable.length > 0 ? indexedSearchText(sql) : indexedMessageText(sql, "messages.payload_json");
  // One transaction: an interrupt between clear and refill would leave an
  // empty index that nothing repairs, since search only checks the table exists.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search)
        VALUES ('delete-all')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_message_search (rowid, text)
        SELECT messages.rowid, ${text}
        FROM orchestration_v2_projection_messages AS messages
        WHERE ${indexedMessageCondition(sql)}
          AND json_extract(messages.payload_json, '$.text') IS NOT NULL
      `;
    }),
  );
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Triggers track projection repairs and commits from other connections too.
  // Auth/session writes deliberately never advance a snapshot revision.
  yield* sql`
    CREATE TABLE orchestration_v2_snapshot_revisions (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY (kind, id)
    ) WITHOUT ROWID
  `;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name GLOB 'orchestration_v2_projection_*'
  `;
  for (const { name } of tables) {
    const columns = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_info(${name})`;
    const keys = columns.flatMap((column) => {
      if (["thread_id", "source_thread_id", "target_thread_id"].includes(column.name)) {
        return [{ kind: "thread", column: column.name }];
      }
      if (name.endsWith("provider_sessions") && column.name === "provider_session_id") {
        return [{ kind: "session", column: column.name }];
      }
      return [];
    });
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const records =
        operation === "UPDATE" ? ["OLD", "NEW"] : [operation === "DELETE" ? "OLD" : "NEW"];
      let statements = records
        .flatMap((record) =>
          keys.map(
            ({ kind, column }) => `
        INSERT INTO orchestration_v2_snapshot_revisions(kind, id, revision)
        SELECT '${kind}', ${record}."${column}", 1 WHERE ${record}."${column}" IS NOT NULL
        ON CONFLICT(kind, id) DO UPDATE SET revision = revision + 1;
      `,
          ),
        )
        .join("\n");
      // Provider threads can also be referenced by another thread's timeline rows.
      if (name.endsWith("provider_threads"))
        statements += `
        INSERT INTO orchestration_v2_snapshot_revisions(kind, id, revision)
        VALUES ('provider-threads', '*', 1)
        ON CONFLICT(kind, id) DO UPDATE SET revision = revision + 1;
      `;
      if (statements.length === 0) continue;
      yield* sql.unsafe(`CREATE TRIGGER "${name}_snapshot_${operation.toLowerCase()}"
        AFTER ${operation} ON "${name}" BEGIN ${statements} END`);
    }
  }
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  // The repository identity a project last resolved to, so a project whose folder was deleted
  // keeps grouping with the rest of its repository.
  if (!columns.some((column) => column.name === "repository_identity_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN repository_identity_json TEXT
    `;
  }
});

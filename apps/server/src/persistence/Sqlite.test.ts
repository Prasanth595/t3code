// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationEntries, runMigrations } from "./Migrations.ts";
import { WAL_SIZE_LIMIT_BYTES } from "./Sqlite.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
require("node:fs").writeSync(1, "locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        holder.stdout.once("data", () => resolve());
        holder.on("error", reject);
        holder.on("exit", () =>
          reject(new Error("lock holder exited before acquiring the write lock")),
        );
      }),
  );

it.effect("waits out a concurrent writer instead of failing with SQLITE_BUSY", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-busy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
    yield* spawnWriteLockHolder(dbPath, 300);
    yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`;
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM busy_probe`;
    assert.deepEqual([...rows], [{ id: 1 }]);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("upgrades an Issues preview file and keeps account bindings after reopening", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-issues-upgrade-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            migrationEntries
              .filter(([id]) => id >= 67)
              .map(([id, name, migration]) => [`${id - 4}_${name}`, migration]),
          ),
        ),
      });
      yield* sql`INSERT INTO issue_tracker_accounts
        VALUES ('linear', 'Account', 'linear.app', 'native-account')`;
      yield* sql`INSERT INTO issue_tracker_bindings
        (project_id, tracker, native_tracker, scope, host, connection_id, updated_at)
        VALUES ('project', ${JSON.stringify({ tracker: "linear", connectionId: "Account" })},
          'linear', 'acme/ENG', 'linear.app', 'Account', '2026-10-15T00:00:00Z')`;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

    for (let open = 0; open < 2; open++) {
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* sql`SELECT * FROM issue_tracker_accounts`, [
          {
            tracker: "linear",
            connection_id: "Account",
            host: "linear.app",
            account_id: "native-account",
          },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT connection_id, scope FROM issue_tracker_bindings`,
          [
            {
              connection_id: "Account",
              scope: "acme/ENG",
            },
          ],
        );
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
        assert.deepStrictEqual(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations
          WHERE migration_id = 70`,
          [{ migration_id: 70, name: "IssueAccountStorage" }],
        );
      }).pipe(
        Effect.provide(
          SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
    }
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("limits the WAL file size in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly journal_size_limit: number }>`PRAGMA journal_size_limit`;
    assert.equal(rows[0]?.journal_size_limit, WAL_SIZE_LIMIT_BYTES);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("drops planner statistics a database already has", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      // Stats from a nearly empty table, as an older build collected on a new install.
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      // A connection still using the old stats scans the table at each step.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("only fsyncs the database file at WAL checkpoints", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-sync-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
    assert.equal(rows[0]?.synchronous, 1);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("applies busy_timeout in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
    assert.equal(rows[0]?.timeout, 5000);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("enables checkpoint_fullfsync in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly checkpoint_fullfsync: number;
    }>`PRAGMA checkpoint_fullfsync`;
    assert.equal(rows[0]?.checkpoint_fullfsync, 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

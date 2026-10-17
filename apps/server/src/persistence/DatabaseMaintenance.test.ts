import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as Sqlite from "./Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

it.layer(DatabaseMaintenance.layer.pipe(Layer.provideMerge(NodeServices.layer)))(
  "DatabaseMaintenance",
  (it) => {
    it.effect("reports an unreadable database as an inspection failure", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-" }),
          "statev2.sqlite",
        );
        yield* fs.writeFileString(dbPath, "not a database");
        const failure = yield* Effect.flip(maintenance.inspect(dbPath));
        assert.equal(failure._tag, "DatabaseInspectError");
      }).pipe(Effect.scoped),
    );

    it.effect.each([0, 2])(
      "compacts offline, drops unused V1 tables, and preserves lazy import data (auto_vacuum %s)",
      (vacuumMode) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-compact-" });
          const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
          // Cover V1 backups with auto_vacuum off and databases already converted by doctor.
          yield* Effect.flatMap(
            ProjectionMaintenance.ProjectionMaintenanceV2,
            (projections) => projections.rebuild,
          ).pipe(
            Effect.provide(
              ProjectionMaintenance.layer.pipe(
                Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
                Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
            VALUES ('legacy', 'project', 'V1 thread', '{"instanceId":"codex","model":"gpt-6"}', 'full-access', 'default', '2026-01-01', '2026-01-01')`;
            yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
            VALUES ('message', 'legacy', 'user', 'Keep transcript', 0, '2026-01-01', '2026-01-01')`;
            yield* sql`INSERT INTO projection_thread_pull_requests (thread_id, host, repository, number, url, source, linked_at)
            VALUES ('legacy', 'github.com', 'example/repo', 1, 'https://github.com/example/repo/pull/1', 'manual', '2026-01-01')`;
            yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
            VALUES ('activity', 'legacy', 'info', 'tool.completed', 'V1 activity', json_object('data', hex(zeroblob(2097152))), '2026-01-01')`;
            yield* sql`CREATE TABLE retained_data (value TEXT)`;
            yield* sql`INSERT INTO retained_data VALUES ('keep')`;
            if (vacuumMode === 0) yield* sql`PRAGMA auto_vacuum = NONE`;
            yield* sql`VACUUM`;
            yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

          const before = yield* maintenance.inspect(dbPath);
          assert.equal(before.incrementalVacuumEnabled, vacuumMode === 2);
          assert.equal(before.reclaimableBytes, 0);
          assert.isTrue(before.hasUnusedV1Tables);
          const sizeBefore = (yield* fs.stat(dbPath)).size;
          // A server that merely has the database open, like an idle one, is enough to refuse.
          const refused = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`SELECT value FROM retained_data`;
            return yield* maintenance.compact(dbPath).pipe(Effect.flip);
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          assert.equal(refused._tag, "DatabaseInUseError");
          assert.equal((yield* fs.stat(dbPath)).size, sizeBefore);

          const result = yield* maintenance.compact(dbPath);
          // The 4 MiB activity payload is removed, allowing 1 MiB for schema overhead.
          assert.isBelow(result.afterBytes, result.beforeBytes - 3 * 1024 * 1024);
          assert.isFalse((yield* maintenance.inspect(dbPath)).hasUnusedV1Tables);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
            assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
            assert.deepEqual(
              yield* sql`
            SELECT name FROM sqlite_master WHERE tbl_name IN (
              'projection_thread_activities', 'projection_turns', 'projection_thread_proposed_plans',
              'projection_pending_approvals', 'projection_state', 'checkpoint_diff_blobs'
            )
          `,
              [],
            );
            assert.deepEqual(yield* sql`SELECT title FROM projection_threads`, [
              { title: "V1 thread" },
            ]);
            assert.deepEqual(yield* sql`SELECT text FROM projection_thread_messages`, [
              { text: "Keep transcript" },
            ]);
            assert.deepEqual(yield* sql`SELECT url FROM projection_thread_pull_requests`, [
              { url: "https://github.com/example/repo/pull/1" },
            ]);
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        }).pipe(Effect.scoped),
    );
  },
);

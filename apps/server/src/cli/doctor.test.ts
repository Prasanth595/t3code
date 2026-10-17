import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as BootService from "../cloud/bootService.ts";
import { runDoctor } from "./doctor.ts";
import * as DatabaseMaintenance from "../persistence/DatabaseMaintenance.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";

it.effect("--fix reclaims space with the service paused, and --dry-run changes nothing", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const doctor = (dryRun: boolean) =>
      runDoctor("/test/statev2.sqlite", { fix: true, dryRun, interactive: false }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.mock(BootService.BootService)({
              withStopped: (operation) =>
                Effect.sync(() => calls.push("pause")).pipe(
                  Effect.andThen(operation),
                  Effect.ensuring(Effect.sync(() => calls.push("resume"))),
                ),
            }),
            Layer.succeed(DatabaseMaintenance.DatabaseMaintenance, {
              // An unconverted database: reclaiming space is recommended.
              inspect: () =>
                Effect.succeed({
                  databaseBytes: 2000,
                  reclaimableBytes: 1000,
                  incrementalVacuumEnabled: false,
                  hasUnusedV1Tables: false,
                }),
              compact: () =>
                Effect.sync(() => {
                  calls.push("compact");
                  return {
                    beforeBytes: 2000,
                    afterBytes: 1000,
                    deletedEventCount: 1,
                    deletedReceiptCount: 0,
                  };
                }),
            }),
          ),
        ),
      );
    yield* doctor(true);
    assert.deepEqual(calls, []);
    yield* doctor(false);
    assert.deepEqual(calls, ["pause", "compact", "resume"]);
  }),
);

it.effect("--fix removes V1 tables with incremental vacuum and no free pages", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-doctor-legacy-" });
    const dbPath = path.join(directory, "statev2.sqlite");
    const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
    yield* Effect.flatMap(
      ProjectionMaintenance.ProjectionMaintenanceV2,
      (store) => store.rebuild,
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
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
        VALUES ('activity', 'legacy', 'info', 'tool.completed', 'V1 activity', json_object('data', hex(zeroblob(524288))), '2026-01-01')`;
      yield* sql`VACUUM`;
      yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
    const before = yield* maintenance.inspect(dbPath);
    assert.isTrue(before.incrementalVacuumEnabled);
    assert.equal(before.reclaimableBytes, 0);
    const paused: boolean[] = [];
    const doctor = (dryRun: boolean) =>
      runDoctor(dbPath, { fix: true, dryRun, interactive: false }).pipe(
        Effect.provide(
          Layer.mock(BootService.BootService)({
            withStopped: (operation) =>
              Effect.sync(() => paused.push(true)).pipe(Effect.andThen(operation)),
          }),
        ),
      );
    yield* doctor(true);
    assert.deepEqual(paused, []);
    assert.deepEqual(yield* maintenance.inspect(dbPath), before);
    yield* doctor(false);
    assert.deepEqual(paused, [true]);
    const after = yield* maintenance.inspect(dbPath);
    assert.isFalse(after.hasUnusedV1Tables);
    assert.isBelow(after.databaseBytes, before.databaseBytes - 512 * 1024);
  }).pipe(
    Effect.scoped,
    Effect.provide(DatabaseMaintenance.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

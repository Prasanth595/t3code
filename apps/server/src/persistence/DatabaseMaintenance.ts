import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export class DatabaseMaintenanceError extends Schema.TaggedError<DatabaseMaintenanceError>()(
  "DatabaseMaintenanceError",
  {
    reason: Schema.Literals(["running", "missing", "invalid-projections", "inspect", "compact"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.reason) {
      case "running":
        return "Stop the T3 Code server and desktop app before compacting the database.";
      case "missing":
        return "No existing T3 Code database was found in this data directory.";
      case "invalid-projections":
        return "Database projections need repair before compaction. Start T3 Code once so it rebuilds them, then run doctor again. If this CLI is older than the one that wrote the database, update T3 Code first.";
      case "inspect":
        return "Could not read the database. Check that this user can open it.";
      case "compact":
        return "Database compaction failed. Check that no other process has the database open and enough disk space is available.";
    }
  }
}

/** Offline inspection and repair of a T3 state database, for `t3 doctor`. */
export class DatabaseMaintenance extends Context.Service<
  DatabaseMaintenance,
  {
    readonly inspect: (databasePath: string) => Effect.Effect<
      {
        readonly databaseBytes: number;
        readonly reclaimableBytes: number;
        readonly incrementalVacuumEnabled: boolean;
      },
      DatabaseMaintenanceError
    >;
    /** Compacts history, then VACUUMs into incremental auto_vacuum. Refuses while a server has it open. */
    readonly compact: (databasePath: string) => Effect.Effect<
      {
        readonly beforeBytes: number;
        readonly afterBytes: number;
        readonly deletedEventCount: number;
        readonly deletedReceiptCount: number;
      },
      DatabaseMaintenanceError
    >;
  }
>()("t3/persistence/DatabaseMaintenance") {}

const isDatabaseMaintenanceError = Schema.is(DatabaseMaintenanceError);

const readStorage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
  const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
  const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
  const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
  const pageSize = size[0]?.page_size ?? 0;
  return {
    databaseBytes: (pages[0]?.page_count ?? 0) * pageSize,
    reclaimableBytes: (free[0]?.freelist_count ?? 0) * pageSize,
    incrementalVacuumEnabled: mode[0]?.auto_vacuum === 2,
  };
});

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const locate = Effect.fn("DatabaseMaintenance.locate")(function* (databasePath: string) {
    if (!(yield* fs.exists(databasePath))) {
      return yield* new DatabaseMaintenanceError({ reason: "missing" });
    }
  });

  const asMaintenanceError = (reason: "inspect" | "compact") =>
    Effect.mapError((cause: unknown) =>
      isDatabaseMaintenanceError(cause) ? cause : new DatabaseMaintenanceError({ reason, cause }),
    );

  const inspect = Effect.fn("DatabaseMaintenance.inspect")(function* (databasePath: string) {
    yield* locate(databasePath);
    return yield* readStorage.pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: databasePath, readonly: true })),
    );
  }, asMaintenanceError("inspect"));

  const compact = Effect.fn("DatabaseMaintenance.compact")(function* (databasePath: string) {
    yield* locate(databasePath);
    const beforeBytes = Number((yield* fs.stat(databasePath)).size);
    const result = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Hold an exclusive lock through compaction and VACUUM. In WAL mode this
      // is refused while any other connection has the file open, even an idle
      // one, which is how a running server or desktop app is detected.
      yield* sql`PRAGMA busy_timeout = 0`;
      yield* sql`PRAGMA locking_mode = EXCLUSIVE`;
      yield* sql`BEGIN EXCLUSIVE`.pipe(
        Effect.mapError((cause) =>
          isSqlError(cause) && cause.reason._tag === "LockTimeoutError"
            ? new DatabaseMaintenanceError({ reason: "running", cause })
            : cause,
        ),
      );
      yield* sql`COMMIT`;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      if (!(yield* maintenance.verify).valid) {
        return yield* new DatabaseMaintenanceError({ reason: "invalid-projections" });
      }
      const summary = yield* maintenance.compactEventStore;
      if (!(yield* maintenance.verify).valid) {
        return yield* new DatabaseMaintenanceError({ reason: "invalid-projections" });
      }
      // VACUUM rebuilds the file, which is the only way to switch an existing
      // database to incremental auto_vacuum; the server reclaims online after.
      yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
      yield* sql`VACUUM`;
      yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
      return summary;
    }).pipe(
      Effect.provide(
        ProjectionMaintenance.layer.pipe(
          Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
          Layer.provideMerge(NodeSqliteClient.layer({ filename: databasePath })),
        ),
      ),
    );
    const afterBytes = Number((yield* fs.stat(databasePath)).size);
    return {
      beforeBytes,
      afterBytes,
      deletedEventCount: result.deletedEventCount,
      deletedReceiptCount: result.deletedReceiptCount,
    };
  }, asMaintenanceError("compact"));

  return DatabaseMaintenance.of({ inspect, compact });
});

export const layer = Layer.effect(DatabaseMaintenance, make);

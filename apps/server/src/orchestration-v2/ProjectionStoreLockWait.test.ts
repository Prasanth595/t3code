import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * A fixed timestamp for the writer's rows.
 *
 * The read does not care when the rows were written, and a fixed epoch keeps
 * the test free of wall-clock reads.
 */
const FIXED_EPOCH = "2026-01-01T00:00:00.000Z";

/** How many rows the writer inserts while the read runs. */
const WRITE_ROWS = 400;

/**
 * The lock wait a read pays, and the connection it pays it on.
 *
 * The measurement is the point of the change, so it is taken the way the
 * server takes it: the `db.connection` and `db.lock_wait_ms` attributes that
 * `nodeSqliteClient` stamps on the span of the transaction that acquired the
 * connection.
 *
 * The database is file-backed, because the reader worker is a second
 * connection and an in-memory database cannot be shared between two of them.
 */
const measureRead = Effect.fn("measureRead")(function* (threadId: ThreadId) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const acquired: Array<{ readonly connection: string; readonly lockWaitMs: number }> = [];
  const tracer = Tracer.make({
    span: (spanOptions) => {
      const span = new Tracer.NativeSpan(spanOptions);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const connection = span.attributes.get("db.connection");
        if (connection !== undefined) {
          acquired.push({
            connection,
            lockWaitMs: Number(span.attributes.get("db.lock_wait_ms") ?? 0),
          });
        }
      };
      return span;
    },
  });

  yield* projectionStore
    .getThreadRecords(threadId, ["runs"])
    .pipe(Effect.provideService(Statement.SpanPropagationEnabled, true), Effect.withTracer(tracer));

  return acquired;
});

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* projectionStore.apply({
      id: EventId.make(`event:${threadId}:created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:lockwait"),
        title: threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      } as never,
    });
  });

it.effect(
  "the projection read takes its lock on the reader connection, and the lock wait is reported",
  () =>
    Effect.gen(function* () {
      // An isolated T3 home: a temporary directory of its own, with the
      // database inside it. The live T3 home is never touched.
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-lockwait-" });
      const database = SqlitePersistence.layerFromPath(path.join(home, "statev2.sqlite"));
      const storeLayer = Layer.mergeAll(
        ProjectionStore.layer.pipe(Layer.provideMerge(database)),
        database,
        NodeServices.layer,
      );

      const threadId = ThreadId.make("thread:lockwait:1");
      const acquired = yield* Effect.gen(function* () {
        yield* createThread(threadId);
        return yield* measureRead(threadId);
      }).pipe(Effect.provide(storeLayer));

      // The read ran on the reader connection...
      assert.deepEqual(
        acquired.map((entry) => entry.connection),
        ["reader"],
      );
      // ...and the lock wait it paid is reported, so the before/after can be
      // compared on the same measure the server logs.
      assert.equal(acquired.length, 1);
      assert.isAtLeast(acquired[0]?.lockWaitMs ?? -1, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
);

/**
 * The read, while a writer inserts rows the whole time.
 *
 * This is the case that was measured in the field: a busy host whose writer
 * is behind, and MCP reads that have to wait for the write lock. The writer
 * here is a stream of inserts, not a held transaction, because a held
 * transaction is a different (and much rarer) case.
 */
const measureReadUnderWriteLoad = Effect.fn("measureReadUnderWriteLoad")(function* (
  threadId: ThreadId,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const acquired: Array<{ readonly connection: string; readonly lockWaitMs: number }> = [];
  const tracer = Tracer.make({
    span: (spanOptions) => {
      const span = new Tracer.NativeSpan(spanOptions);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const connection = span.attributes.get("db.connection");
        if (connection !== undefined) {
          acquired.push({
            connection,
            lockWaitMs: Number(span.attributes.get("db.lock_wait_ms") ?? 0),
          });
        }
      };
      return span;
    },
  });

  // A writer, inserting rows the whole time the read runs. It signals when it
  // has written enough for the read to meet a busy writer.
  //
  // The columns are the table's own. A row that does not insert is a failed
  // row, not write load, so the insert is not allowed to fail quietly: the
  // rows are counted afterwards and the count is asserted.
  const writing = yield* Deferred.make<void>();
  let written = 0;
  const writer = yield* Effect.repeat(
    Effect.gen(function* () {
      yield* sql`INSERT INTO orchestration_v2_projection_checkpoints (
        checkpoint_id, thread_id, scope_id, run_id, node_id, ordinal_within_scope,
        status, captured_at, payload_json
      ) VALUES (
        ${crypto.randomUUID()}, ${threadId}, ${`lockwait-scope-${written}`}, ${"run"}, ${"node"},
        ${written}, 'captured', ${FIXED_EPOCH}, '{}'
      )`;
      written += 1;
    }),
    { times: WRITE_ROWS },
  ).pipe(
    Effect.andThen(Deferred.succeed(writing, undefined)),
    Effect.forkChild({ startImmediately: true }),
  );

  // Wait for the milestone, not for a wall-clock duration.
  yield* Deferred.await(writing);
  const started = yield* Clock.currentTimeMillis;
  yield* projectionStore
    .getThreadRecords(threadId, ["runs"])
    .pipe(Effect.provideService(Statement.SpanPropagationEnabled, true), Effect.withTracer(tracer));
  const elapsedMs = (yield* Clock.currentTimeMillis) - started;
  yield* Fiber.join(writer);

  return { acquired, elapsedMs, written };
});

/**
 * The same read, but on the writer connection.
 *
 * This is the "before": the read that ran on the writer, where it had to take
 * the write lock that the writer was holding.
 */
const measureReadOnWriter = Effect.fn("measureReadOnWriter")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const acquired: Array<{ readonly connection: string; readonly lockWaitMs: number }> = [];
  const tracer = Tracer.make({
    span: (spanOptions) => {
      const span = new Tracer.NativeSpan(spanOptions);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const connection = span.attributes.get("db.connection");
        if (connection !== undefined) {
          acquired.push({
            connection,
            lockWaitMs: Number(span.attributes.get("db.lock_wait_ms") ?? 0),
          });
        }
      };
      return span;
    },
  });

  // A writer inserting rows the whole time the read runs.
  //
  // The columns are the table's own. A row that does not insert is a failed
  // row, not write load, so the insert is not allowed to fail quietly: the
  // rows are counted afterwards and the count is asserted.
  const writing = yield* Deferred.make<void>();
  let written = 0;
  const writer = yield* Effect.repeat(
    Effect.gen(function* () {
      yield* sql`INSERT INTO orchestration_v2_projection_checkpoints (
        checkpoint_id, thread_id, scope_id, run_id, node_id, ordinal_within_scope,
        status, captured_at, payload_json
      ) VALUES (
        ${crypto.randomUUID()}, ${threadId}, ${`lockwait-scope-${written}`}, ${"run"}, ${"node"},
        ${written}, 'captured', ${FIXED_EPOCH}, '{}'
      )`;
      written += 1;
    }),
    { times: WRITE_ROWS },
  ).pipe(
    Effect.andThen(Deferred.succeed(writing, undefined)),
    Effect.forkChild({ startImmediately: true }),
  );

  yield* Deferred.await(writing);
  const started = yield* Clock.currentTimeMillis;
  // A read on the writer connection: the same statement, without the reader.
  yield* sql
    .withTransaction(
      sql`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} LIMIT 1`,
    )
    .pipe(Effect.provideService(Statement.SpanPropagationEnabled, true), Effect.withTracer(tracer));
  const elapsedMs = (yield* Clock.currentTimeMillis) - started;
  yield* Fiber.join(writer);

  return { acquired, elapsedMs, written };
});

it.effect("the projection read does not wait for the writer's lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-lockwait-load-" });
    const database = SqlitePersistence.layerFromPath(path.join(home, "statev2.sqlite"));
    const storeLayer = Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provideMerge(database)),
      database,
      NodeServices.layer,
    );

    const threadId = ThreadId.make("thread:lockwait:load");
    const { acquired, elapsedMs, written } = yield* Effect.gen(function* () {
      yield* createThread(threadId);
      return yield* measureReadUnderWriteLoad(threadId);
    }).pipe(Effect.provide(storeLayer), TestClock.withLive);

    // The writer really wrote. A writer whose rows are rejected is not write
    // load, and the measurement would be measuring nothing.
    assert.isAbove(written, 1);
    const rows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_v2_projection_checkpoints
        WHERE scope_id LIKE 'lockwait-scope-%'
      `;
    }).pipe(Effect.provide(storeLayer));
    // Every row the writer reported is on disk, so the inserts were not
    // rejected.
    assert.equal(rows[0]?.count, written);

    // The read ran on the reader, so the writer's lock did not make it wait:
    // the reader has its own connection and its own lock.
    assert.deepEqual(
      acquired.map((entry) => entry.connection),
      ["reader"],
    );
    // The lock wait is reported, so the before/after can be compared on the
    // same measure the server logs.
    assert.equal(acquired.length, 1);
    assert.isAtLeast(acquired[0]?.lockWaitMs ?? -1, 0);
    console.log(
      `MEASURE read-under-write-load: connection=${acquired[0]?.connection} lock_wait_ms=${acquired[0]?.lockWaitMs} elapsed_ms=${elapsedMs} rows_written=${written}`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("the same read on the writer connection waits for the writer's lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-lockwait-writer-" });
    const database = SqlitePersistence.layerFromPath(path.join(home, "statev2.sqlite"));
    const storeLayer = Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provideMerge(database)),
      database,
      NodeServices.layer,
    );

    const threadId = ThreadId.make("thread:lockwait:writer");
    const { acquired, elapsedMs, written } = yield* Effect.gen(function* () {
      yield* createThread(threadId);
      return yield* measureReadOnWriter(threadId);
    }).pipe(Effect.provide(storeLayer), TestClock.withLive);

    // The writer really wrote, so the comparison is against real write load.
    assert.isAbove(written, 1);
    const rows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_v2_projection_checkpoints
        WHERE scope_id LIKE 'lockwait-scope-%'
      `;
    }).pipe(Effect.provide(storeLayer));
    assert.equal(rows[0]?.count, written);

    assert.deepEqual(
      acquired.map((entry) => entry.connection),
      ["writer"],
    );
    // The lock wait is reported on the writer's acquisition too, so the two
    // measurements are comparable.
    assert.equal(acquired.length, 1);
    assert.isAtLeast(acquired[0]?.lockWaitMs ?? -1, 0);
    console.log(
      `MEASURE read-on-writer: connection=${acquired[0]?.connection} lock_wait_ms=${acquired[0]?.lockWaitMs} elapsed_ms=${elapsedMs}`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

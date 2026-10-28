import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  ProviderThreadId,
  RunId,
  RunAttemptId,
  CommandId,
  MessageId,
  NodeId,
  EventId,
  GuestShareId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as EventStore from "./EventStore.ts";
import * as Stream from "effect/Stream";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as TemporaryThreadDiagnostics from "../observability/TemporaryThreadDiagnostics.ts";
import * as TemporaryThreadStorage from "./TemporaryThreadStorage.ts";
import * as TemporaryThreadService from "./TemporaryThreadService.ts";

const layerTest = TemporaryThreadStorage.layer.pipe(
  Layer.provide(Sqlite.layerMemory),
  Layer.provideMerge(TemporaryThreadDiagnostics.layer),
);
const threadId = ThreadId.make("temporary-sentinel");
const commandId = CommandId.make("create-sentinel");
const createThread = Effect.fn("test.createTemporaryThread")(function* (
  threadId: ThreadId,
  commandId: CommandId,
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.commitCommand({
    threadId,
    commandId,
    commandType: "thread.create",
    acceptedAt: now,
    events: [
      {
        id: EventId.make("event-" + commandId),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          createdBy: "user",
          creationSource: "web",
          projectId: ProjectId.make("project"),
          title: "private-sentinel-content",
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
        },
      },
    ],
    effects: [
      { id: "effect-" + commandId, commandId, threadId, request: { type: "terminal.cleanup" } },
    ],
  });
});

const create = createThread(threadId, commandId);

it.effect("looks up saved guest shares without exposing volatile invites", () =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const savedId = ThreadId.make("saved-guest-share");
    const savedShareId = GuestShareId.make("saved-share");
    const temporaryShareId = GuestShareId.make("temporary-share");
    yield* createThread(savedId, CommandId.make("create-saved-guest-share"));
    yield* storage.register({ threadId });
    yield* create;
    const now = yield* DateTime.now;
    for (const [id, shareId, store] of [
      [savedId, savedShareId, stores.durable],
      [threadId, temporaryShareId, stores.volatile],
    ] as const) {
      yield* store.projectionStore.apply({
        id: EventId.make("share-" + id),
        type: "thread.guest-share-updated",
        threadId: id,
        occurredAt: now,
        payload: {
          ...(yield* store.projectionStore.getThread(id)),
          guestShare: {
            id: shareId,
            host: "env.t3.test",
            createdAt: DateTime.formatIso(now),
            expiresAt: DateTime.formatIso(DateTime.add(now, { hours: 24 })),
            guestName: null,
            messages: [],
          },
        },
      });
      assert.equal(yield* store.projectionStore.findGuestShareThreadId(shareId), id);
    }
    assert.equal(yield* projection.findGuestShareThreadId(savedShareId), savedId);
    assert.isNull(yield* projection.findGuestShareThreadId(temporaryShareId));
    assert.isNull(yield* projection.findGuestShareThreadId(GuestShareId.make("unknown-share")));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("routes the full temporary write away from durable SQL", () =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    yield* storage.register({ threadId });
    yield* create;
    for (const table of [
      "orchestration_events",
      "orchestration_command_receipts",
      "orchestration_v2_projection_threads",
      "orchestration_v2_effect_outbox",
    ]) {
      const rows = yield* stores.durable.sql.unsafe(`SELECT * FROM ${table}`);
      assert.equal(rows.length, 0);
    }
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    assert.equal((yield* projection.getThread(threadId)).title, "private-sentinel-content");
    assert.isTrue((yield* projection.getThreadSnapshot(threadId)).projection.thread.temporary);
    const pragma = yield* stores.volatile.sql<{ temp_store: number }>`PRAGMA temp_store`;
    assert.equal(pragma[0]?.temp_store, 2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "keeps family IDs, receipts, positions and running leases, native child: %s",
  (nativeChild) =>
    Effect.gen(function* () {
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
      const child = ThreadId.make("child-sentinel");
      yield* storage.register({ threadId });
      yield* create;
      if (nativeChild) {
        const sink = yield* EventSink.EventSinkV2;
        const projection = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const childCommand = CommandId.make("child-create");
        const write = {
          events: [
            {
              id: EventId.make("native-child"),
              type: "thread.created",
              threadId: child,
              occurredAt: now,
              payload: {
                ...(yield* projection.getThread(threadId)),
                id: child,
                lineage: {
                  parentThreadId: threadId,
                  relationshipToParent: "subagent",
                  rootThreadId: threadId,
                },
              },
            },
          ],
          effects: [
            {
              id: "effect-child-create",
              commandId: childCommand,
              threadId: child,
              request: { type: "terminal.cleanup" },
            },
          ],
        } satisfies Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0];
        const skipped = yield* sink.writeIfRunCurrent({
          ...write,
          threadId,
          runId: RunId.make("missing-run"),
          activeAttemptId: RunAttemptId.make("missing-attempt"),
          expectedStatus: "running",
        });
        assert.isFalse(skipped.committed);
        assert.isFalse(yield* storage.isTemporary(child));
        yield* stores.volatile
          .sql`CREATE TRIGGER reject_child BEFORE INSERT ON orchestration_v2_projection_threads WHEN NEW.thread_id = 'child-sentinel' BEGIN SELECT RAISE(ABORT, 'child failure'); END`;
        assert.equal((yield* Effect.exit(sink.writeWithEffects(write)))._tag, "Failure");
        assert.isFalse(yield* storage.isTemporary(child));
        yield* stores.volatile.sql`DROP TRIGGER reject_child`;
        yield* sink.writeWithEffects(write);
        assert.isTrue(yield* storage.isTemporary(child));
        assert.equal((yield* stores.durable.sql`SELECT * FROM orchestration_events`).length, 0);
      } else {
        yield* storage.register({ threadId: child, parentThreadId: threadId });
        yield* createThread(child, CommandId.make("child-create"));
      }
      yield* positions.allocate({ threadId, turnItemId: TurnItemId.make("item"), runId: null });
      const claim = yield* outbox.claimNext({ workerId: "worker" });
      assert.isTrue(Option.isSome(claim));
      const before = yield* storage.generation(threadId);
      yield* storage.keep({ threadId, commandId: CommandId.make("keep") });
      assert.isFalse(yield* storage.isTemporary(threadId));
      assert.isFalse(yield* storage.isTemporary(child));
      assert.notEqual(yield* storage.generation(threadId), before);
      assert.isTrue(Option.isSome(yield* receipts.getByCommandId(commandId)));
      const copied = yield* outbox.get(Option.getOrThrow(claim).id);
      assert.isTrue(Option.isSome(copied));
      if (Option.isSome(copied)) {
        assert.equal(copied.value.status, "running");
        assert.equal(copied.value.leaseOwner, "worker");
        assert.equal(copied.value.attemptCount, 1);
      }
      assert.equal(
        yield* positions.allocate({ threadId, turnItemId: TurnItemId.make("item"), runId: null }),
        1,
      );
      assert.isTrue(
        yield* outbox.succeed({ effectId: Option.getOrThrow(claim).id, workerId: "worker" }),
      );
      yield* storage.keep({ threadId, commandId: CommandId.make("keep") });
      assert.equal(
        (yield* stores.durable.sql`SELECT * FROM orchestration_v2_effect_outbox`).length,
        2,
      );
      const rows = yield* stores.durable.sql`SELECT * FROM orchestration_events`;
      assert.equal(rows.length, 2);
      assert.equal((yield* stores.volatile.sql`SELECT * FROM orchestration_events`).length, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("rolls back Keep on a durable conflict and leaves all data temporary", () =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    yield* storage.register({ threadId });
    yield* create;
    yield* stores.durable
      .sql`CREATE TRIGGER reject_temporary BEFORE INSERT ON orchestration_v2_projection_threads BEGIN SELECT RAISE(ABORT, 'test failure'); END`;
    assert.isTrue(
      (yield* Effect.exit(storage.keep({ threadId, commandId: CommandId.make("keep") })))._tag ===
        "Failure",
    );
    assert.isTrue(yield* storage.isTemporary(threadId));
    assert.equal((yield* stores.durable.sql`SELECT * FROM orchestration_events`).length, 0);
    assert.equal((yield* stores.volatile.sql`SELECT * FROM orchestration_events`).length, 1);
    yield* stores.durable.sql`DROP TRIGGER reject_temporary`;
    yield* storage.keep({ threadId, commandId: CommandId.make("keep") });
    assert.isFalse(yield* storage.isTemporary(threadId));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("discards a family and rejects late writes and re-registration", () =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    yield* storage.register({ threadId });
    yield* create;
    yield* storage.markDiscarding(threadId);
    yield* storage.discard(threadId);
    assert.isTrue(yield* storage.isDiscarded(threadId));
    assert.equal((yield* Effect.exit(create))._tag, "Failure");
    assert.equal((yield* Effect.exit(storage.register({ threadId })))._tag, "Failure");
    assert.equal((yield* stores.volatile.sql`SELECT * FROM orchestration_events`).length, 0);
    assert.equal((yield* stores.durable.sql`SELECT * FROM orchestration_events`).length, 0);
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* Stream.runCollect(sink.readByCommandId({ commandId }));
    assert.equal(events.length, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps provider sessions referenced only through thread bindings", () =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    yield* storage.register({ threadId });
    yield* create;
    yield* stores.volatile
      .sql`INSERT INTO orchestration_v2_projection_provider_sessions (provider_session_id, thread_id, provider, status, updated_at, payload_json) VALUES ('session', NULL, 'codex', 'ready', '2026-10-24T00:00:00.000Z', '{}')`;
    yield* stores.volatile
      .sql`INSERT INTO orchestration_v2_projection_provider_session_bindings (provider_session_id, thread_id) VALUES ('session', ${threadId})`;
    yield* storage.keep({ threadId, commandId: CommandId.make("keep") });
    const sessions = yield* stores.durable
      .sql`SELECT * FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id = 'session'`;
    assert.equal(sessions.length, 1);
    assert.equal(
      (yield* stores.volatile.sql`SELECT * FROM orchestration_v2_projection_provider_sessions`)
        .length,
      0,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "keeps a shared Codex session with an existing saved binding", compatible: true },
  {
    name: "rolls back Keep when a session ID belongs to another provider instance",
    compatible: false,
  },
])("$name", ({ compatible }) =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    const sink = yield* EventSink.EventSinkV2;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const savedId = ThreadId.make("saved-session-owner");
    yield* createThread(savedId, CommandId.make("create-saved"));
    const now = yield* DateTime.now;
    const session = {
      id: ProviderSessionId.make("shared-codex-session"),
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make(compatible ? "codex" : "other-codex"),
      status: "stopped" as const,
      cwd: "/saved-workspace",
      model: "gpt-5.4",
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: "saved process stopped",
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("attach-saved-session"),
          type: "provider-session.attached",
          threadId: savedId,
          occurredAt: now,
          payload: session,
        },
      ],
    });
    const savedThread = yield* projection.getThread(savedId);
    const savedSessionRows = yield* stores.durable
      .sql`SELECT * FROM orchestration_v2_projection_provider_sessions`;
    const savedEventRows = yield* stores.durable.sql`SELECT * FROM orchestration_events`;
    yield* storage.register({ threadId });
    yield* create;
    const liveSession = {
      ...session,
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "ready" as const,
      cwd: "/temporary-workspace",
      lastError: null,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("attach-temporary-session"),
          type: "provider-session.attached",
          threadId,
          occurredAt: now,
          payload: liveSession,
        },
      ],
    });
    const kept = yield* Effect.exit(storage.keep({ threadId, commandId: CommandId.make("keep") }));
    if (!compatible) {
      assert.equal(kept._tag, "Failure");
      assert.isTrue(yield* storage.isTemporary(threadId));
      assert.deepEqual(
        yield* stores.durable.sql`SELECT * FROM orchestration_v2_projection_provider_sessions`,
        savedSessionRows,
      );
      assert.deepEqual(
        yield* stores.durable.sql`SELECT * FROM orchestration_events`,
        savedEventRows,
      );
      assert.deepEqual(
        yield* stores.durable
          .sql`SELECT thread_id FROM orchestration_v2_projection_provider_session_bindings`,
        [{ thread_id: savedId }],
      );
      return;
    }
    assert.equal(kept._tag, "Success");
    assert.isFalse(yield* storage.isTemporary(threadId));
    assert.deepEqual(yield* projection.getThread(savedId), savedThread);
    assert.deepEqual(
      yield* stores.durable
        .sql`SELECT thread_id FROM orchestration_v2_projection_provider_session_bindings ORDER BY thread_id`,
      [{ thread_id: savedId }, { thread_id: threadId }],
    );
    for (const id of [savedId, threadId]) {
      assert.deepEqual(
        (yield* projection.getThreadRecords(id, ["providerSessions"])).providerSessions,
        [liveSession],
      );
    }
    assert.equal(
      (yield* stores.durable.sql`SELECT * FROM orchestration_v2_projection_provider_sessions`)
        .length,
      1,
    );
    assert.equal(
      (yield* stores.volatile.sql`SELECT * FROM orchestration_v2_projection_provider_sessions`)
        .length,
      0,
    );
    assert.equal(
      (yield* stores.volatile
        .sql`SELECT * FROM orchestration_v2_projection_provider_session_bindings`).length,
      0,
    );
    assert.equal(
      (yield* stores.durable.sql`SELECT * FROM orchestration_events WHERE stream_id = ${savedId}`)
        .length,
      savedEventRows.length,
    );
    const updatedSession = { ...liveSession, status: "running" as const };
    yield* sink.write({
      events: [
        {
          id: EventId.make("update-kept-session"),
          type: "provider-session.updated",
          threadId,
          occurredAt: now,
          payload: updatedSession,
        },
      ],
    });
    assert.deepEqual(
      (yield* projection.getThreadRecords(savedId, ["providerSessions"])).providerSessions,
      [updatedSession],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects native ownership in the other SQL store before publishing or writing", () =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    const sink = yield* EventSink.EventSinkV2;
    yield* storage.register({ threadId });
    yield* stores.durable
      .sql`INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver, provider_instance_id) VALUES ('owned', 'other-thread', 'codex', 'ready', '2026-10-24T00:00:00.000Z', '{"nativeThreadRef":{"nativeId":"native"}}', 'codex', 'codex')`;
    const now = yield* DateTime.now;
    const result = yield* sink.write({
      unlessNativeThreadOwned: {
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        appThreadId: threadId,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "native",
          strength: "strong",
        },
      },
      events: [
        {
          id: EventId.make("detached"),
          threadId,
          type: "provider-session.detached",
          occurredAt: now,
          payload: { providerSessionId: ProviderSessionId.make("session"), detachedAt: now },
        },
      ],
    });
    assert.equal(result.length, 0);
    assert.equal((yield* stores.volatile.sql`SELECT * FROM orchestration_events`).length, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps temporary content out of database, WAL and journal files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const dbPath = directory + "/state.sqlite";
    const diskLayer = TemporaryThreadStorage.layer.pipe(
      Layer.provide(Sqlite.layerFromPath(dbPath)),
    );
    yield* Effect.gen(function* () {
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      yield* storage.register({ threadId });
      yield* create;
      for (const path of [dbPath, dbPath + "-wal", dbPath + "-journal"]) {
        if (!(yield* fs.exists(path))) continue;
        const bytes = yield* fs.readFile(path);
        assert.isFalse(new TextDecoder().decode(bytes).includes("private-sentinel-content"));
        assert.isFalse(new TextDecoder().decode(bytes).includes("temporary-sentinel"));
      }
    }).pipe(Effect.provide(diskLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not route one command ID to two owners", () =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    yield* stores.durable
      .sql`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error, command_type) VALUES (${commandId}, 'thread', 'other-thread', '2026-10-24T00:00:00.000Z', 0, 'accepted', NULL, 'thread.create')`;
    yield* storage.register({ threadId });
    assert.equal((yield* Effect.exit(create))._tag, "Failure");
    assert.equal((yield* stores.volatile.sql`SELECT * FROM orchestration_events`).length, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "storage registration gates diagnostics and successful Keep restores ordinary logging",
  () =>
    Effect.gen(function* () {
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      const diagnostics = yield* TemporaryThreadDiagnostics.TemporaryThreadDiagnostics;
      assert.isTrue(diagnostics.canRecord());
      yield* storage.register({ threadId });
      yield* create;
      assert.isTrue(diagnostics.hasTemporaryThreads());
      assert.isFalse(diagnostics.canRecord());
      yield* storage.keep({ threadId, commandId: CommandId.make("keep-diagnostics") });
      assert.isFalse(diagnostics.hasTemporaryThreads());
      assert.isTrue(diagnostics.canRecord());
      assert.isTrue(diagnostics.canSnapshot());
    }).pipe(Effect.provide(layerTest)),
);

it.effect("failed Keep preserves diagnostic privacy and discard protects residual data", () =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    const diagnostics = yield* TemporaryThreadDiagnostics.TemporaryThreadDiagnostics;
    yield* storage.register({ threadId });
    yield* create;
    yield* stores.durable
      .sql`CREATE TRIGGER reject_private BEFORE INSERT ON orchestration_v2_projection_threads BEGIN SELECT RAISE(ABORT, 'test failure'); END`;
    assert.equal(
      (yield* Effect.result(storage.keep({ threadId, commandId: CommandId.make("keep-fails") })))
        ._tag,
      "Failure",
    );
    assert.isTrue(diagnostics.hasTemporaryThreads());
    assert.isFalse(diagnostics.canRecord());
    yield* storage.discard(threadId);
    assert.isFalse(diagnostics.hasTemporaryThreads());
    assert.isFalse(diagnostics.canRecord());
    assert.isFalse(diagnostics.canSnapshot());
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "Keep preserves effect order and retry backoff, already retrying: %s",
  (retryBeforeKeep) =>
    Effect.gen(function* () {
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* storage.register({ threadId });
      yield* create;
      yield* outbox.enqueue([
        {
          id: "first-rollback",
          commandId,
          threadId,
          request: {
            type: "provider-thread.rollback",
            providerThreadId: ProviderThreadId.make("provider"),
            checkpointId: CheckpointId.make("checkpoint"),
            scopeId: CheckpointScopeId.make("scope"),
          },
        },
        {
          id: "second-capture",
          commandId,
          threadId,
          request: {
            type: "checkpoint.capture",
            runId: RunId.make("run"),
            scopeId: CheckpointScopeId.make("scope"),
          },
        },
      ]);
      const initial = Option.getOrThrow(yield* outbox.claimNext({ workerId: "worker" }));
      assert.equal(initial.id, "effect-create-sentinel");
      yield* outbox.succeed({ effectId: initial.id, workerId: "worker" });
      if (retryBeforeKeep) {
        const claimed = Option.getOrThrow(yield* outbox.claimNext({ workerId: "worker" }));
        assert.equal(claimed.id, "first-rollback");
        yield* outbox.retry({
          effectId: claimed.id,
          workerId: "worker",
          error: "retry before Keep",
          delayMs: 1000,
        });
      }
      yield* storage.keep({ threadId, commandId: CommandId.make("keep-order") });
      if (retryBeforeKeep) {
        assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId: "worker" })));
        yield* TestClock.adjust("1 second");
      }
      const first = Option.getOrThrow(yield* outbox.claimNext({ workerId: "worker" }));
      assert.equal(first.id, "first-rollback");
      yield* outbox.retry({
        effectId: first.id,
        workerId: "worker",
        error: "retry",
        delayMs: 1000,
      });
      assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId: "worker" })));
      yield* TestClock.adjust("1 second");
      assert.equal(
        Option.getOrThrow(yield* outbox.claimNext({ workerId: "worker" })).id,
        "first-rollback",
      );
      yield* outbox.succeed({ effectId: first.id, workerId: "worker" });
      assert.equal(
        Option.getOrThrow(yield* outbox.claimNext({ workerId: "worker" })).id,
        "second-capture",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "Keep saves whole-thread history and rejects stale temporary retention on later writes",
  () =>
    Effect.gen(function* () {
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
      const sink = yield* EventSink.EventSinkV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      yield* storage.register({ threadId });
      yield* create;
      const before = yield* projection.getThread(threadId);
      const now = yield* DateTime.now;
      for (const type of ["thread.metadata-updated", "thread.visited"] as const) {
        yield* sink.write({
          events: [
            {
              id: EventId.make(type),
              threadId,
              type,
              occurredAt: now,
              payload: { ...before, title: "saved title", lastVisitedAt: now },
            },
          ],
        });
      }
      yield* storage.keep({ threadId, commandId: CommandId.make("keep-history") });
      const history = yield* Stream.runCollect(stores.durable.eventStore.read({ threadId }));
      assert.deepEqual(
        history.map((stored) =>
          "temporary" in stored.event.payload ? stored.event.payload.temporary : undefined,
        ),
        [undefined, undefined, undefined],
      );
      yield* ProjectionMaintenance.ProjectionMaintenanceV2.use(
        (maintenance) => maintenance.rebuild,
      ).pipe(
        Effect.provide(
          ProjectionMaintenance.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(SqlClient.SqlClient, stores.durable.sql),
                Layer.succeed(EventStore.EventStoreV2, stores.durable.eventStore),
                Layer.succeed(ProjectionStore.ProjectionStoreV2, stores.durable.projectionStore),
              ),
            ),
          ),
        ),
      );
      assert.isUndefined(
        (yield* projection.getThreadSnapshot(threadId)).projection.thread.temporary,
      );
      assert.isUndefined((yield* projection.getThreadShell(threadId))?.temporary);
      yield* sink.write({
        events: [
          {
            id: EventId.make("late-snapshot"),
            threadId,
            type: "thread.metadata-updated",
            occurredAt: now,
            payload: before,
          },
        ],
      });
      assert.isUndefined((yield* projection.getThread(threadId)).temporary);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("an active thread stream follows Keep without replaying imported history", () =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    const sink = yield* EventSink.EventSinkV2;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    yield* createThread(ThreadId.make("existing-durable"), CommandId.make("existing-create"));
    yield* storage.register({ threadId });
    yield* create;
    const pull = yield* Stream.toPull(sink.stream({ threadId }));
    assert.equal((yield* pull)[0]?.event.type, "thread.created");
    yield* storage.keep({ threadId, commandId: CommandId.make("keep-stream") });
    const event = {
      id: EventId.make("after-keep"),
      type: "thread.metadata-updated" as const,
      threadId,
      occurredAt: yield* DateTime.now,
      payload: yield* projection.getThread(threadId),
    };
    yield* sink.write({ events: [event] });
    yield* stores.volatile.eventSink.write({
      events: [{ ...event, id: EventId.make("stale-memory-witness") }],
    });
    assert.deepEqual(
      (yield* pull).map((stored) => stored.event.id),
      ["after-keep"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("discard closes an active thread stream", () =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    const sink = yield* EventSink.EventSinkV2;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    yield* storage.register({ threadId });
    yield* create;
    const before = yield* projection.getThread(threadId);
    const pull = yield* Stream.toPull(sink.stream({ threadId }));
    yield* pull;
    yield* storage.discard(threadId);
    yield* stores.volatile.eventSink.write({
      events: [
        {
          id: EventId.make("after-discard-witness"),
          threadId,
          type: "thread.metadata-updated",
          occurredAt: yield* DateTime.now,
          payload: before,
        },
      ],
    });
    assert.equal((yield* Effect.result(pull))._tag, "Failure");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "failed memory retirement keeps durable settlement and receipts authoritative and retries cleanup",
  () =>
    Effect.gen(function* () {
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* storage.register({ threadId });
      yield* create;
      yield* outbox.enqueue([
        { id: "after-running", threadId, commandId, request: { type: "terminal.cleanup" } },
      ]);
      const running = Option.getOrThrow(yield* outbox.claimNext({ workerId: "worker" }));
      const before = yield* stores.volatile
        .sql`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;
      const counts: Array<readonly [string, number]> = [];
      for (const row of before) {
        const name = String(row.name);
        counts.push([
          name,
          (yield* stores.volatile.sql`SELECT * FROM ${stores.volatile.sql(name)}`).length,
        ]);
      }
      yield* stores.volatile
        .sql`CREATE TRIGGER fail_retirement BEFORE DELETE ON orchestration_v2_effect_outbox BEGIN SELECT RAISE(ABORT, 'retirement failed'); END`;
      const keepId = CommandId.make("keep-retirement");
      yield* storage.keep({ threadId, commandId: keepId });
      assert.isFalse(yield* storage.isTemporary(threadId));
      assert.isTrue(yield* outbox.succeed({ effectId: running.id, workerId: "worker" }));
      assert.equal(
        Option.getOrThrow(yield* stores.durable.effectOutbox.get(running.id)).status,
        "succeeded",
      );
      assert.isTrue(Option.isSome(yield* receipts.getByCommandId(commandId)));
      assert.equal((yield* Stream.runCollect(sink.readByCommandId({ commandId }))).length, 1);
      yield* create;
      assert.equal((yield* outbox.listByCommandId(commandId)).length, 2);
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      assert.equal(
        (yield* projection.getShellSnapshot()).threads.filter((thread) => thread.id === threadId)
          .length,
        1,
      );
      const next = Option.getOrThrow(yield* outbox.claimNext({ workerId: "worker" }));
      assert.equal(next.id, "after-running");
      yield* outbox.succeed({ effectId: next.id, workerId: "worker" });
      assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId: "worker" })));
      assert.isTrue(Option.isNone(yield* outbox.nextClaimableAt));
      for (const [name, count] of counts)
        assert.equal(
          (yield* stores.volatile.sql`SELECT * FROM ${stores.volatile.sql(name)}`).length,
          count,
        );
      yield* stores.volatile.sql`DROP TRIGGER fail_retirement`;
      yield* storage.keep({ threadId, commandId: keepId });
      assert.equal((yield* stores.volatile.sql`SELECT * FROM orchestration_events`).length, 0);
      assert.equal(
        (yield* stores.volatile.sql`SELECT * FROM orchestration_v2_effect_outbox`).length,
        0,
      );
      assert.equal((yield* stores.durable.sql`SELECT * FROM orchestration_events`).length, 1);
      assert.equal(
        (yield* stores.durable
          .sql`SELECT * FROM orchestration_command_receipts WHERE command_id = ${keepId}`).length,
        1,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("rejecting registration of a saved thread preserves diagnostics", () =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const diagnostics = yield* TemporaryThreadDiagnostics.TemporaryThreadDiagnostics;
    yield* create;
    const rejected = yield* Effect.result(storage.register({ threadId }));
    assert.equal(rejected._tag, "Failure");
    if (rejected._tag === "Failure")
      assert.equal(rejected.failure._tag, "TemporaryThreadAlreadyDurableError");
    assert.isFalse(diagnostics.hasTemporaryThreads());
    assert.isTrue(diagnostics.canRecord());
    assert.isTrue(diagnostics.canSnapshot());
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "work notifications remain live after Keep (delegated %s)",
  (delegated) =>
    Effect.gen(function* () {
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      const sink = yield* EventSink.EventSinkV2;
      yield* storage.register({ threadId });
      yield* create;
      const updates = yield* storage.subscribeThreadRunUpdates(threadId, delegated);
      const pull = yield* Stream.toPull(updates);
      yield* storage.keep({ threadId, commandId: CommandId.make("keep-run-updates") });
      assert.deepEqual(yield* pull, [undefined]);
      const now = yield* DateTime.now;
      yield* sink.write({
        events: delegated
          ? [
              {
                id: EventId.make("work-after-keep"),
                threadId,
                type: "subagent.updated" as const,
                occurredAt: now,
                payload: {
                  id: NodeId.make("child-work"),
                  threadId,
                  runId: null,
                  parentNodeId: NodeId.make("parent-work"),
                  origin: "app_owned" as const,
                  createdBy: "agent" as const,
                  driver: ProviderDriverKind.make("codex"),
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  providerThreadId: null,
                  childThreadId: null,
                  nativeTaskRef: null,
                  prompt: "private task",
                  title: null,
                  model: null,
                  status: "completed" as const,
                  result: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ]
          : [
              {
                id: EventId.make("completed-after-keep"),
                threadId,
                type: "run.updated",
                occurredAt: now,
                payload: {
                  id: RunId.make("live-run"),
                  threadId,
                  ordinal: 1,
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
                  providerThreadId: null,
                  userMessageId: MessageId.make("live-message"),
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: "completed",
                  requestedAt: now,
                  startedAt: now,
                  completedAt: now,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
            ],
      });
      assert.deepEqual(yield* pull, [undefined]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([2, 3])("retries failed RAM deletion on leave generation %s", (generation) =>
  Effect.gen(function* () {
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    const identity = { sessionId: "session", clientId: "client" };
    const view = (generation: number, threadIds: ReadonlyArray<ThreadId>) => ({
      viewId: "view",
      generation,
      threadIds,
      background: false,
    });
    let cleanupCalls = 0;
    yield* Effect.gen(function* () {
      const service = yield* TemporaryThreadService.TemporaryThreadService;
      yield* storage.register({ threadId });
      yield* create;
      yield* service.updateViews(identity, view(1, [threadId]));
      yield* stores.volatile
        .sql`CREATE TRIGGER reject_discard BEFORE DELETE ON orchestration_v2_projection_threads BEGIN SELECT RAISE(ABORT, 'test failure'); END`;
      assert.equal(
        (yield* Effect.exit(service.updateViews(identity, view(2, []))))._tag,
        "Failure",
      );
      assert.equal((yield* stores.volatile.sql`SELECT * FROM orchestration_events`).length, 1);
      assert.isTrue(yield* storage.isTemporary(threadId));
      assert.isFalse(yield* storage.isDiscarded(threadId));
      yield* stores.volatile.sql`DROP TRIGGER reject_discard`;
      yield* service.updateViews(identity, view(generation, []));
      assert.isTrue(yield* storage.isDiscarded(threadId));
      assert.isFalse(yield* storage.isTemporary(threadId));
      assert.equal(cleanupCalls, 2);
      for (const table of [
        "orchestration_events",
        "orchestration_command_receipts",
        "orchestration_v2_projection_threads",
        "orchestration_v2_effect_outbox",
      ]) {
        assert.equal((yield* stores.volatile.sql.unsafe(`SELECT * FROM ${table}`)).length, 0);
        assert.equal((yield* stores.durable.sql.unsafe(`SELECT * FROM ${table}`)).length, 0);
      }
      assert.equal((yield* Effect.exit(create))._tag, "Failure");
      assert.equal((yield* Effect.exit(storage.register({ threadId })))._tag, "Failure");
    }).pipe(
      Effect.provide(
        TemporaryThreadService.layer.pipe(
          Layer.provide(TemporaryThreadService.layerState),
          Layer.provide(
            Layer.succeed(TemporaryThreadService.TemporaryThreadCleanup, {
              stopAndTeardown: () =>
                Effect.sync(() => {
                  cleanupCalls++;
                }),
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(layerTest)),
);

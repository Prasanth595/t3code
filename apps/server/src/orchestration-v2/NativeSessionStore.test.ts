import { expect, it } from "@effect/vitest";
import { EventId, ThreadId, TurnItemId, CommandId, NativeSessionRecord } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as NativeSessionStore from "./NativeSessionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layer = ProjectionStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const record = (threadId: string) =>
  Schema.decodeUnknownSync(NativeSessionRecord)({
    key: "host:store:native",
    environmentId: "environment",
    projectId: "project",
    threadId,
    providerInstanceId: "codex",
    binding: {
      home: "/private/codex",
      nativeId: "019bd450-188a-7000-8000-000000000001",
      cwd: "/private/project",
      nativeStores: {
        sessionStore: "/private/codex/sessions",
        sessionStoreIdentity: "1:2:0",
        writerLockStore: "/private/codex/thread-writer-locks",
        writerLockStoreIdentity: "1:3:0",
      },
      protocolVersion: "0.164.0",
      transport: {
        kind: "shared-daemon",
        proof: {
          process: { pid: 100, start: "20", boot: "boot" },
          executable: "/bin/codex",
          codexIdentity: "1:4:0",
          socket: "/private/socket",
          socketIdentity: "1:5:0",
          controlIdentity: "1:6:0",
          rendezvous: "/private/codex/socket",
          rendezvousIdentity: "1:7:0",
          uid: 1000,
        },
      },
    },
    settings: {
      model: "gpt-5.4",
      reasoningEffort: "high",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
    controller: { type: "adopting", epoch: 1 },
    history: { authority: "native", generation: 0, complete: false },
    operationId: "019bd450-188a-7000-8000-000000000002",
    releaseReceipt: null,
    blockers: [],
  });
it.effect("persists one native binding independent of app thread and provider generation", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const first = record("thread-one");
    yield* projections.apply({
      type: "native-session.updated",
      id: EventId.make("native:one"),
      threadId: first.threadId,
      occurredAt: now,
      payload: { type: "session", value: first },
    });
    const error = yield* Effect.flip(
      projections.apply({
        type: "native-session.updated",
        id: EventId.make("native:two"),
        threadId: ThreadId.make("thread-two"),
        occurredAt: now,
        payload: { type: "session", value: record("thread-two") },
      }),
    );
    expect(error._tag).toBe("ProjectionStoreApplyEventError");
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM orchestration_v2_native_sessions`;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload_json)).toEqual(first);
  }).pipe(Effect.provide(layer)),
);

const storeLayer = NativeSessionStore.layer.pipe(
  Layer.provide(
    EventSink.layer.pipe(Layer.provide(Layer.merge(ProjectionStore.layer, EventStore.layer))),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
);
it.effect(
  "revokes new admission while retaining already admitted unknown delivery across state changes",
  () =>
    Effect.gen(function* () {
      const store = yield* NativeSessionStore.NativeSessionStore;
      const session = { ...record("thread-gate"), controller: { type: "t3" as const, epoch: 3 } };
      yield* store.write([{ type: "session", value: session }]);
      const effect = {
        id: "turn:one",
        threadId: session.threadId,
        operationId: session.operationId,
        epoch: 3,
        connectionId: "connection",
        method: "turn/start",
        paramsHash: "input-one",
        state: "uncertain" as const,
      };
      yield* store.admit(effect);
      yield* store.write([
        { type: "session", value: { ...session, controller: { type: "releasing", epoch: 4 } } },
      ]);
      expect((yield* store.effects(session.threadId)).map((value) => value.id)).toEqual([
        "turn:one",
      ]);
      expect((yield* Effect.flip(store.admit({ ...effect, id: "turn:two" }))).code).toBe(
        "stale-controller",
      );
      expect((yield* Effect.flip(store.admit(effect))).code).toBe("unknown-delivery");
      yield* store.acknowledge(effect.id, session.threadId, "native-turn-one");
      expect(yield* store.effects(session.threadId)).toMatchObject([
        { state: "acknowledged", nativeTurnId: "native-turn-one" },
      ]);
    }).pipe(Effect.provide(storeLayer)),
);
it.effect("rejects changed payload under one operation or command identity", () =>
  Effect.gen(function* () {
    const store = yield* NativeSessionStore.NativeSessionStore;
    const session = record("thread-operation");
    const op = {
      operationId: session.operationId,
      commandId: CommandId.make("command-one"),
      threadId: session.threadId,
      kind: "adopt" as const,
      payloadHash: "hash-one",
      result: null,
    };
    yield* store.begin(op);
    expect((yield* store.begin(op)).payloadHash).toBe("hash-one");
    expect((yield* Effect.flip(store.begin({ ...op, payloadHash: "hash-two" }))).code).toBe(
      "operation-conflict",
    );
    expect(
      (yield* Effect.flip(
        store.begin({ ...op, operationId: "019bd450-188a-7000-8000-000000000003" }),
      )).code,
    ).toBe("operation-conflict");
  }).pipe(Effect.provide(storeLayer)),
);

it.effect(
  "atomically reconciles native history identities and removes only native imported rows after truncation",
  () =>
    Effect.gen(function* () {
      const store = yield* NativeSessionStore.NativeSessionStore;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-history");
      const entry = {
        ordinal: 1,
        nativeTurnId: "turn-one",
        nativeItemId: "item-one",
        messageId: null,
        turnItemId: TurnItemId.make("native-item"),
        payloadHash: "hash-one",
      };
      yield* store.write([{ type: "history", value: { threadId, generation: 1, items: [entry] } }]);
      yield* store.write([
        {
          type: "history",
          value: { threadId, generation: 2, items: [{ ...entry, payloadHash: "hash-two" }] },
        },
      ]);
      expect(yield* store.historyIndex(threadId)).toMatchObject([
        { nativeTurnId: "turn-one", nativeItemId: "item-one", payloadHash: "hash-two" },
      ]);
      yield* store.write([{ type: "history", value: { threadId, generation: 3, items: [] } }]);
      expect(yield* store.historyIndex(threadId)).toEqual([]);
      expect(
        yield* sql`SELECT 1 FROM orchestration_v2_native_history WHERE thread_id = ${threadId}`,
      ).toEqual([]);
    }).pipe(Effect.provide(storeLayer)),
);

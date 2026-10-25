// @effect-diagnostics nodeBuiltinImport:off -- Receipt IDs and canonical SHA-256 hashes use Node crypto.
import * as NodeCrypto from "node:crypto";
import {
  type OrchestrationV2DomainEvent,
  NativeSessionHistoryItem,
  EventId,
  NativeSessionEffect,
  NativeSessionError,
  NativeSessionOperation,
  NativeSessionRecord,
  type NativeSessionJournalEntry,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "./EventSink.ts";

export function nativePayloadHash(value: unknown): string {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : input !== null && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input)
              .filter(([, value]) => value !== undefined)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, value]) => [key, canonical(value)]),
          )
        : input;
  return NodeCrypto.createHash("sha256")
    .update(Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(canonical(value)))
    .digest("hex");
}
export class NativeSessionStore extends Context.Service<
  NativeSessionStore,
  {
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<NativeSessionRecord>, NativeSessionError>;
    readonly byNativeId: (
      nativeId: string,
    ) => Effect.Effect<Option.Option<NativeSessionRecord>, NativeSessionError>;
    readonly byKey: (
      key: string,
    ) => Effect.Effect<Option.Option<NativeSessionRecord>, NativeSessionError>;
    readonly operation: (
      operationId: string,
    ) => Effect.Effect<Option.Option<NativeSessionOperation>, NativeSessionError>;
    readonly begin: (
      operation: NativeSessionOperation,
    ) => Effect.Effect<NativeSessionOperation, NativeSessionError>;
    readonly effects: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<NativeSessionEffect>, NativeSessionError>;
    readonly historyIndex: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<NativeSessionHistoryItem>, NativeSessionError>;
    readonly write: (
      entries: ReadonlyArray<NativeSessionJournalEntry>,
      projections?: ReadonlyArray<OrchestrationV2DomainEvent>,
      threadCommit?: EventSink.ThreadProjectionCommit,
    ) => Effect.Effect<void, NativeSessionError>;
    readonly admit: (effect: NativeSessionEffect) => Effect.Effect<void, NativeSessionError>;
    readonly acknowledge: (
      effectId: string,
      threadId: ThreadId,
      nativeTurnId?: string,
      lifecycleResult?: NativeSessionEffect["lifecycleResult"],
    ) => Effect.Effect<void, NativeSessionError>;
    readonly withLock: KeyedLock.KeyedLock<ThreadId>["withLock"];
  }
>()("t3/orchestration-v2/NativeSessionStore") {}

const ThreadIdPlaceholder = ThreadId.make("native-session:lookup");

export const layer = Layer.effect(
  NativeSessionStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    const locks = yield* KeyedLock.make<ThreadId>();
    const decodeSession = Schema.decodeEffect(Schema.fromJsonString(NativeSessionRecord));
    const decodeOperation = Schema.decodeEffect(Schema.fromJsonString(NativeSessionOperation));
    const decodeEffect = Schema.decodeEffect(Schema.fromJsonString(NativeSessionEffect));
    const persistence = (threadId: ThreadId) => (cause: unknown) =>
      new NativeSessionError({ code: "persistence", threadId, cause });
    const get = Effect.fn("NativeSessionStore.get")(function* (threadId: ThreadId) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_native_sessions WHERE thread_id = ${threadId}`.pipe(
        Effect.mapError(persistence(threadId)),
      );
      return rows[0]
        ? Option.some(
            yield* decodeSession(rows[0].payload_json).pipe(Effect.mapError(persistence(threadId))),
          )
        : Option.none();
    });
    const byKey = Effect.fn("NativeSessionStore.byKey")(function* (key: string) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_native_sessions WHERE native_key = ${key}`.pipe(
        Effect.mapError(persistence(ThreadIdPlaceholder)),
      );
      return rows[0]
        ? Option.some(
            yield* decodeSession(rows[0].payload_json).pipe(
              Effect.mapError(persistence(ThreadIdPlaceholder)),
            ),
          )
        : Option.none();
    });
    const byNativeId = Effect.fn("NativeSessionStore.byNativeId")(function* (nativeId: string) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_native_sessions WHERE json_extract(payload_json, '$.binding.nativeId') = ${nativeId}`.pipe(
        Effect.mapError(persistence(ThreadIdPlaceholder)),
      );
      return rows[0]
        ? Option.some(
            yield* decodeSession(rows[0].payload_json).pipe(
              Effect.mapError(persistence(ThreadIdPlaceholder)),
            ),
          )
        : Option.none();
    });
    const operation = Effect.fn("NativeSessionStore.operation")(function* (operationId: string) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_native_operations WHERE operation_id = ${operationId}`.pipe(
        Effect.mapError(persistence(ThreadIdPlaceholder)),
      );
      return rows[0]
        ? Option.some(
            yield* decodeOperation(rows[0].payload_json).pipe(
              Effect.mapError(persistence(ThreadIdPlaceholder)),
            ),
          )
        : Option.none();
    });
    const events = Effect.fn("NativeSessionStore.events")(function* (
      entries: ReadonlyArray<NativeSessionJournalEntry>,
    ) {
      const occurredAt = yield* DateTime.now;
      return entries.map((payload) => ({
        id: EventId.make(`native:${NodeCrypto.randomUUID()}`),
        threadId: payload.value.threadId,
        occurredAt,
        type: "native-session.updated" as const,
        payload,
      }));
    });
    const write = Effect.fn("NativeSessionStore.write")(function* (
      entries: ReadonlyArray<NativeSessionJournalEntry>,
      projections: ReadonlyArray<OrchestrationV2DomainEvent> = [],
      threadCommit?: EventSink.ThreadProjectionCommit,
    ) {
      if (entries.length === 0) return;
      const committed = yield* sink
        .write({
          events: [...(yield* events(entries)), ...projections],
          ...(threadCommit === undefined ? {} : { threadCommit }),
        })
        .pipe(Effect.mapError(persistence(entries[0]!.value.threadId)));
      if (threadCommit !== undefined && committed.length === 0)
        return yield* new NativeSessionError({
          code: "thread-policy-changed",
          threadId: entries[0]!.value.threadId,
        });
    });
    const effects = Effect.fn("NativeSessionStore.effects")(function* (threadId: ThreadId) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_native_effects WHERE thread_id = ${threadId} ORDER BY rowid`.pipe(
        Effect.mapError(persistence(threadId)),
      );
      return yield* Effect.forEach(rows, (row) =>
        decodeEffect(row.payload_json).pipe(Effect.mapError(persistence(threadId))),
      );
    });
    const historyIndex = Effect.fn("NativeSessionStore.historyIndex")(function* (
      threadId: ThreadId,
    ) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_native_history WHERE thread_id = ${threadId}`.pipe(
        Effect.mapError(persistence(threadId)),
      );
      return yield* Effect.forEach(rows, (row) =>
        Schema.decodeEffect(Schema.fromJsonString(NativeSessionHistoryItem))(row.payload_json).pipe(
          Effect.mapError(persistence(threadId)),
        ),
      );
    });
    const begin = Effect.fn("NativeSessionStore.begin")(function* (input: NativeSessionOperation) {
      return yield* locks.withLock(
        input.threadId,
        Effect.gen(function* () {
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_native_operations WHERE operation_id = ${input.operationId} OR command_id = ${input.commandId}`.pipe(
            Effect.mapError(persistence(input.threadId)),
          );
          if (rows.length > 0) {
            const saved = yield* decodeOperation(rows[0]!.payload_json).pipe(
              Effect.mapError(persistence(input.threadId)),
            );
            if (
              rows.length !== 1 ||
              saved.operationId !== input.operationId ||
              saved.commandId !== input.commandId ||
              saved.threadId !== input.threadId ||
              saved.kind !== input.kind ||
              saved.payloadHash !== input.payloadHash
            )
              return yield* new NativeSessionError({
                code: "operation-conflict",
                threadId: input.threadId,
              });
            return saved;
          }
          yield* sink
            .commitCommand({
              commandId: input.commandId,
              threadId: input.threadId,
              commandType: `nativeSessions.${input.kind}`,
              acceptedAt: yield* DateTime.now,
              events: yield* events([{ type: "operation", value: input }]),
              effects: [],
            })
            .pipe(Effect.mapError(persistence(input.threadId)));
          const saved = yield* operation(input.operationId);
          if (Option.isNone(saved))
            return yield* new NativeSessionError({
              code: "operation-conflict",
              threadId: input.threadId,
            });
          return saved.value;
        }),
      );
    });
    const effectById = Effect.fn("NativeSessionStore.effectById")(function* (
      id: string,
      threadId: ThreadId,
    ) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_native_effects WHERE effect_id = ${id} AND thread_id = ${threadId}`.pipe(
        Effect.mapError(persistence(threadId)),
      );
      return rows[0]
        ? Option.some(
            yield* decodeEffect(rows[0].payload_json).pipe(Effect.mapError(persistence(threadId))),
          )
        : Option.none();
    });
    const outstandingEffects = Effect.fn("NativeSessionStore.outstandingEffects")(function* (
      threadId: ThreadId,
    ) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_native_effects WHERE thread_id = ${threadId} AND state IN ('uncertain', 'awaiting-response')`.pipe(
        Effect.mapError(persistence(threadId)),
      );
      return yield* Effect.forEach(rows, (row) =>
        decodeEffect(row.payload_json).pipe(Effect.mapError(persistence(threadId))),
      );
    });
    const admit = Effect.fn("NativeSessionStore.admit")(function* (effect: NativeSessionEffect) {
      return yield* locks.withLock(
        effect.threadId,
        Effect.gen(function* () {
          const existing = yield* outstandingEffects(effect.threadId);
          const repeated = yield* effectById(effect.id, effect.threadId);
          if (Option.isSome(repeated))
            return yield* new NativeSessionError({
              code:
                repeated.value.state === "uncertain"
                  ? "unknown-delivery"
                  : "effect-already-delivered",
              threadId: effect.threadId,
            });
          const session = yield* get(effect.threadId);
          if (Option.isNone(session) || session.value.controller.epoch !== effect.epoch)
            return yield* new NativeSessionError({
              code: "stale-controller",
              threadId: effect.threadId,
            });
          const control = session.value.controller.type;
          const lifecycle =
            session.value.operationId === effect.operationId &&
            ((control === "adopting" && effect.method === "thread/resume") ||
              (control === "releasing" &&
                ["turn/interrupt", "thread/unsubscribe", "thread/resume"].includes(effect.method)));
          if (control !== "t3" && !lifecycle)
            return yield* new NativeSessionError({
              code: "controller-unavailable",
              threadId: effect.threadId,
            });
          if (
            existing.some((value) => value.state === "awaiting-response") &&
            effect.method !== "turn/interrupt" &&
            !effect.method.startsWith("server-response:")
          )
            return yield* new NativeSessionError({
              code: "native-pending-request",
              threadId: effect.threadId,
            });
          if (existing.some((value) => value.state === "uncertain"))
            return yield* new NativeSessionError({
              code: "unknown-delivery",
              threadId: effect.threadId,
            });
          yield* write([{ type: "effect", value: effect }]);
        }),
      );
    });
    const acknowledge = Effect.fn("NativeSessionStore.acknowledge")(function* (
      effectId: string,
      threadId: ThreadId,
      nativeTurnId?: string,
      lifecycleResult?: NativeSessionEffect["lifecycleResult"],
    ) {
      return yield* locks.withLock(
        threadId,
        Effect.gen(function* () {
          const existing = Option.getOrNull(yield* effectById(effectId, threadId));
          if (!existing) return yield* new NativeSessionError({ code: "unknown-effect", threadId });
          yield* write([
            {
              type: "effect",
              value: {
                ...existing,
                state: "acknowledged",
                ...(nativeTurnId === undefined ? {} : { nativeTurnId }),
                ...(lifecycleResult === undefined ? {} : { lifecycleResult }),
              },
            },
          ]);
        }),
      );
    });
    return NativeSessionStore.of({
      get,
      byKey,
      byNativeId,
      operation,
      begin,
      write,
      effects,
      historyIndex,
      admit,
      acknowledge,
      withLock: locks.withLock,
    });
  }),
);

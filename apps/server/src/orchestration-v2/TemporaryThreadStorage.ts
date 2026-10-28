import {
  CommandId,
  ThreadId,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSessionJson,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as ApplicationReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as TemporaryThreadDiagnostics from "../observability/TemporaryThreadDiagnostics.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

export class TemporaryThreadStorageError extends Schema.TaggedError<TemporaryThreadStorageError>()(
  "TemporaryThreadStorageError",
  {
    operation: Schema.String,
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Temporary thread storage ${this.operation} failed.`;
  }
}

export class TemporaryThreadAlreadyDurableError extends Schema.TaggedError<TemporaryThreadAlreadyDurableError>()(
  "TemporaryThreadAlreadyDurableError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "Temporary thread storage already-durable failed.";
  }
}

type StorageChange = {
  readonly type: "registered" | "kept" | "discarding" | "discarded";
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly generation: string;
};

export class TemporaryThreadStorage extends Context.Service<
  TemporaryThreadStorage,
  {
    readonly register: (input: {
      readonly threadId: ThreadId;
      readonly parentThreadId?: ThreadId;
    }) => Effect.Effect<void, TemporaryThreadStorageError | TemporaryThreadAlreadyDurableError>;
    readonly isTemporary: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly isDiscarded: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly family: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ThreadId>>;
    readonly markDiscarding: (
      threadId: ThreadId,
    ) => Effect.Effect<void, TemporaryThreadStorageError>;
    readonly keep: (input: {
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
    }) => Effect.Effect<void, TemporaryThreadStorageError>;
    readonly discard: (threadId: ThreadId) => Effect.Effect<void, TemporaryThreadStorageError>;
    readonly subscribeThreadRunUpdates: (
      threadId: ThreadId,
      includeDelegatedWork?: boolean,
    ) => Effect.Effect<
      Stream.Stream<void, EventSink.EventSinkV2Error>,
      EventSink.EventSinkV2Error,
      Scope.Scope
    >;
    readonly generation: (threadId: ThreadId) => Effect.Effect<string>;
    readonly changes: Stream.Stream<StorageChange>;
  }
>()("t3/orchestration-v2/TemporaryThreadStorage") {}

type RawStores = {
  readonly sql: SqlClient.SqlClient;
  readonly projectStore: ProjectStore.ProjectStoreV2["Service"];
  readonly eventSink: EventSink.EventSinkV2["Service"];
  readonly eventStore: EventStore.EventStoreV2["Service"];
  readonly projectionStore: ProjectionStore.ProjectionStoreV2["Service"];
  readonly effectOutbox: EffectOutbox.EffectOutboxV2["Service"];
  readonly commandReceipts: CommandReceiptStore.CommandReceiptStoreV2["Service"];
  readonly applicationEvents: ApplicationEvents.OrchestrationEventStore["Service"];
  readonly applicationReceipts: ApplicationReceipts.OrchestrationCommandReceiptRepository["Service"];
  readonly providerSessionRuntime: ProviderSessionRuntime.ProviderSessionRuntimeRepository["Service"];
  readonly turnItemPositions: TurnItemPositionStore.TurnItemPositionStoreV2["Service"];
};

export class TemporaryThreadStores extends Context.Service<
  TemporaryThreadStores,
  {
    readonly durable: RawStores;
    readonly volatile: RawStores;
    readonly getShellSnapshot: ProjectionStore.ProjectionStoreV2["Service"]["getShellSnapshot"];
  }
>()("t3/orchestration-v2/TemporaryThreadStorage/TemporaryThreadStores") {}

const rawInfrastructure = Layer.mergeAll(ApplicationEvents.layer, ApplicationReceipts.layer);
const rawStores = Layer.mergeAll(
  EventStore.layerFromOrchestrationEventStore,
  CommandReceiptStore.layerFromApplicationReceipts,
  ProjectionStore.layer,
  ProjectStore.layer,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
  ProviderSessionRuntime.layer,
).pipe(Layer.provideMerge(rawInfrastructure));
const rawLayer = EventSink.layerFromStores.pipe(Layer.provideMerge(rawStores));
const capture = Effect.gen(function* () {
  return {
    sql: yield* SqlClient.SqlClient,
    projectStore: yield* ProjectStore.ProjectStoreV2,
    eventSink: yield* EventSink.EventSinkV2,
    eventStore: yield* EventStore.EventStoreV2,
    projectionStore: yield* ProjectionStore.ProjectionStoreV2,
    effectOutbox: yield* EffectOutbox.EffectOutboxV2,
    commandReceipts: yield* CommandReceiptStore.CommandReceiptStoreV2,
    applicationEvents: yield* ApplicationEvents.OrchestrationEventStore,
    applicationReceipts: yield* ApplicationReceipts.OrchestrationCommandReceiptRepository,
    providerSessionRuntime: yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
    turnItemPositions: yield* TurnItemPositionStore.TurnItemPositionStoreV2,
  } satisfies RawStores;
});

type Row = Record<string, string | number | null>;
const isTemporaryThreadStorageError = Schema.is(TemporaryThreadStorageError);
const jsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeObject = Schema.decodeUnknownEffect(jsonObject);
const encodeObject = Schema.encodeEffect(jsonObject);
const decodeProviderSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
const wholeThreadEventTypes = new Set<string>(
  OrchestrationV2DomainEvent.members
    .filter((member) => member.fields.payload === OrchestrationV2AppThread)
    .flatMap((member) => {
      const type = member.fields.type;
      return "literals" in type ? type.literals : [type.literal];
    }),
);

const isWholeThreadEvent = (
  event: OrchestrationV2DomainEvent,
): event is Extract<OrchestrationV2DomainEvent, { readonly payload: OrchestrationV2AppThread }> =>
  wholeThreadEventTypes.has(event.type);

const make = Effect.gen(function* () {
  const durableSql = yield* SqlClient.SqlClient;
  const diagnostics = yield* Effect.serviceOption(
    TemporaryThreadDiagnostics.TemporaryThreadDiagnostics,
  );
  const signalsContext = yield* Layer.build(EffectOutbox.layerSignals);
  const signals = Context.get(signalsContext, EffectOutbox.EffectOutboxSignals);
  const buildRaw = <E, R>(
    sqlLayer: Layer.Layer<SqlClient.SqlClient, E, R>,
    excludedThreadIds: () => ReadonlyArray<ThreadId> = () => [],
  ) =>
    Layer.build(
      rawLayer.pipe(
        Layer.provideMerge(sqlLayer),
        Layer.provide(Layer.succeed(EffectOutbox.EffectOutboxSignals, signals)),
        Layer.provide(Layer.succeed(EffectOutbox.EffectOutboxThreadFilter, { excludedThreadIds })),
      ),
    ).pipe(Effect.flatMap((context) => Effect.provide(capture, context)));
  const owners = new Map<
    ThreadId,
    {
      root: ThreadId;
      state: "temporary" | "discarding" | "discarded" | "durable";
      generation: string;
    }
  >();
  const pendingRetirements = new Map<ThreadId, ReadonlyArray<ThreadId>>();
  const durable = yield* buildRaw(Layer.succeed(SqlClient.SqlClient, durableSql));
  const volatile = yield* buildRaw(Layer.fresh(Sqlite.layerMemory), () =>
    Array.from(pendingRetirements.values()).flat(),
  );
  const gate = yield* Semaphore.make(1);
  const changeBus = yield* PubSub.unbounded<StorageChange>();
  const generationCursors = new Map<string, number>();
  const epoch = yield* Random.nextInt;
  let revision = 0;
  const nextGeneration = () => epoch + ":" + ++revision;
  const family = (id: ThreadId) => {
    const root = owners.get(id)?.root ?? id;
    return Array.from(owners)
      .filter(([, owner]) => owner.root === root)
      .map(([key]) => key);
  };
  const temporary = (id: ThreadId) => {
    const state = owners.get(id)?.state;
    return state === "temporary" || state === "discarding";
  };
  const target = (id?: ThreadId) => (id !== undefined && temporary(id) ? volatile : durable);
  const assertWritable = Effect.fn("TemporaryThreadStorage.assertWritable")(function* (
    ids: ReadonlyArray<ThreadId>,
  ) {
    for (const id of ids)
      if (owners.get(id)?.state === "discarded")
        return yield* new TemporaryThreadStorageError({ operation: "discarded", threadId: id });
    if (new Set(ids.map((id) => target(id))).size > 1)
      return yield* new TemporaryThreadStorageError({
        operation: "mixed-stores",
        threadId: ids[0]!,
      });
    return ids.length === 0 ? durable : target(ids[0]);
  });
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermit(effect);
  const getShellSnapshot = Effect.fn("TemporaryThreadStorage.getShellSnapshot")(
    function* (options?: ProjectionStore.ShellSnapshotOptions) {
      const read = yield* durable.sql
        .withTransaction(
          Effect.all({
            disk: durable.projectionStore.readShellSnapshot(options),
            memory: volatile.projectionStore.readShellSnapshot(options),
            snapshotSequence: durable.applicationEvents.latestApplicationSequence,
          }),
        )
        .pipe(NodeSqliteClient.readOnly);
      const disk = yield* read.disk;
      const memory = yield* read.memory;
      return {
        ...disk,
        snapshotSequence: read.snapshotSequence,
        threads: [
          ...disk.threads,
          ...memory.threads
            .filter((thread) => temporary(thread.id))
            .map((thread) => ({ ...thread, temporary: true })),
        ],
        archivedThreads: [
          ...disk.archivedThreads,
          ...memory.archivedThreads
            .filter((thread) => temporary(thread.id))
            .map((thread) => ({ ...thread, temporary: true })),
        ],
      };
    },
    locked,
    Effect.mapError(
      (cause) =>
        new ProjectionStore.ProjectionStoreReadError({
          threadId: ThreadId.make("thread:shell"),
          cause,
        }),
    ),
  );
  const withThread = <A, E, R>(id: ThreadId, use: (stores: RawStores) => Effect.Effect<A, E, R>) =>
    locked(Effect.suspend(() => use(target(id))));
  const withWrite = <A, E, R>(
    ids: ReadonlyArray<ThreadId>,
    use: (stores: RawStores) => Effect.Effect<A, E, R>,
  ) => locked(assertWritable(ids).pipe(Effect.flatMap(use)));
  const subscribeEvents = Effect.fn("TemporaryThreadStorage.subscribeEvents")(function* (
    input: NonNullable<Parameters<EventSink.EventSinkV2["Service"]["stream"]>[0]> & {
      readonly threadId: ThreadId;
    },
  ) {
    const threadId = input.threadId;
    const subscription = yield* PubSub.subscribe(changeBus);
    const initialGeneration = owners.get(threadId)?.generation ?? "durable";
    const initialStore = target(threadId);
    const afterSequence =
      input.afterSequence ?? (yield* initialStore.eventSink.latestSequence({ threadId }));
    const changes = Stream.fromSubscription(subscription).pipe(
      Stream.filter(
        (change) =>
          change.threadIds.includes(threadId) &&
          (change.type === "kept" || change.type === "discarded"),
      ),
    );
    return Stream.concat(
      Stream.succeed({
        type:
          owners.get(threadId)?.state === "discarded"
            ? ("discarded" as const)
            : ("registered" as const),
        threadIds: [threadId],
        generation: initialGeneration,
      }),
      changes,
    ).pipe(
      Stream.takeUntil((change) => change.type === "discarded"),
      Stream.switchMap((change) =>
        change.type === "discarded"
          ? Stream.empty
          : change.type === "kept"
            ? durable.eventSink.stream({
                ...input,
                afterSequence: generationCursors.get(change.generation)!,
              })
            : initialStore.eventSink.stream({ ...input, afterSequence }),
      ),
    );
  }, locked);
  const commandTarget = Effect.fn("TemporaryThreadStorage.commandTarget")(
    function* (id: CommandId) {
      const memory = yield* volatile.applicationReceipts.getByCommandId({ commandId: id });
      const disk = yield* durable.applicationReceipts.getByCommandId({ commandId: id });
      const memoryEvents = Option.isSome(memory)
        ? []
        : yield* volatile.sql<{
            stream_id: string;
          }>`SELECT stream_id FROM orchestration_events WHERE command_id = ${id} LIMIT 1`;
      const diskEvents = Option.isSome(disk)
        ? []
        : yield* durable.sql`SELECT 1 FROM orchestration_events WHERE command_id = ${id} LIMIT 1`;
      const inMemory = Option.isSome(memory)
        ? memory.value.aggregateKind === "thread" &&
          temporary(ThreadId.make(memory.value.aggregateId))
        : memoryEvents.some((event) => temporary(ThreadId.make(event.stream_id)));
      const onDisk = Option.isSome(disk) || diskEvents.length > 0;
      if (inMemory && onDisk)
        return yield* new PersistenceSqlError({
          operation: "TemporaryThreadStorage.commandCollision",
        });
      return inMemory ? volatile : durable;
    },
    Effect.mapError(
      (cause) =>
        new PersistenceSqlError({ operation: "TemporaryThreadStorage.commandTarget", cause }),
    ),
  );
  const effectTarget = Effect.fn("TemporaryThreadStorage.effectTarget")(function* (id: string) {
    const row = yield* volatile.effectOutbox.get(id);
    return Option.isSome(row) && temporary(row.value.threadId) ? volatile : durable;
  });
  const providerTarget = Effect.fn("TemporaryThreadStorage.providerTarget")(function* (id: string) {
    const rows = yield* volatile.sql<{
      thread_id: string;
    }>`SELECT thread_id FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${id}`;
    return rows.some((row) => temporary(ThreadId.make(row.thread_id))) ? volatile : durable;
  });
  const tables = yield* volatile.sql<{
    name: string;
  }>`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;
  const threadTables: Array<{ name: string; column: string }> = [];
  for (const { name } of tables) {
    const columns = yield* volatile.sql.unsafe<{ name: string }>("PRAGMA table_info(" + name + ")");
    if (columns.some((column) => column.name === "thread_id"))
      threadTables.push({ name, column: "thread_id" });
  }
  threadTables.push(
    { name: "orchestration_events", column: "stream_id" },
    { name: "orchestration_command_receipts", column: "aggregate_id" },
  );
  const familyRows = Effect.fn("TemporaryThreadStorage.familyRows")(function* (
    ids: ReadonlyArray<ThreadId>,
  ) {
    const result: Array<{ name: string; rows: ReadonlyArray<Row> }> = [];
    for (const { name, column } of threadTables) {
      const rows =
        name === "orchestration_v2_projection_provider_sessions"
          ? yield* volatile.sql<Row>`SELECT * FROM orchestration_v2_projection_provider_sessions WHERE thread_id IN ${volatile.sql.in(ids)} OR provider_session_id IN (SELECT provider_session_id FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id IN ${volatile.sql.in(ids)})`
          : name === "orchestration_v2_effect_outbox"
            ? yield* volatile.sql<Row>`SELECT * FROM orchestration_v2_effect_outbox WHERE thread_id IN ${volatile.sql.in(ids)} ORDER BY rowid`
            : yield* volatile.sql<Row>`SELECT * FROM ${volatile.sql(name)} WHERE ${volatile.sql(column)} IN ${volatile.sql.in(ids)}`;
      result.push({ name, rows });
    }
    return result;
  });
  const clearFamily = Effect.fn("TemporaryThreadStorage.clearFamily")(function* (
    ids: ReadonlyArray<ThreadId>,
  ) {
    for (const { name, column } of threadTables) {
      if (name === "orchestration_v2_projection_provider_sessions") {
        yield* volatile.sql`DELETE FROM orchestration_v2_projection_provider_sessions WHERE thread_id IN ${volatile.sql.in(ids)} OR (provider_session_id IN (SELECT provider_session_id FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id IN ${volatile.sql.in(ids)}) AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_session_bindings b WHERE b.provider_session_id = orchestration_v2_projection_provider_sessions.provider_session_id AND b.thread_id NOT IN ${volatile.sql.in(ids)}))`;
      } else
        yield* volatile.sql`DELETE FROM ${volatile.sql(name)} WHERE ${volatile.sql(column)} IN ${volatile.sql.in(ids)}`;
    }
  });
  const retireFamily = Effect.fn("TemporaryThreadStorage.retireFamily")(function* (root: ThreadId) {
    const ids = pendingRetirements.get(root);
    if (ids === undefined) return;
    yield* volatile.sql.withTransaction(clearFamily(ids)).pipe(
      Effect.matchEffect({
        onFailure: () =>
          Effect.logWarning("Temporary thread memory retirement pending").pipe(
            Effect.annotateLogs({
              operation: "TemporaryThreadStorage.retireFamily",
              threadCount: ids.length,
            }),
          ),
        onSuccess: () =>
          Effect.sync(() => {
            pendingRetirements.delete(root);
          }),
      }),
    );
  });
  const mirrorProjects = Effect.fn("TemporaryThreadStorage.mirrorProjects")(function* () {
    const projects = yield* durable.sql<Row>`SELECT * FROM projection_projects`;
    yield* volatile.sql`DELETE FROM projection_projects`;
    for (const row of projects)
      yield* volatile.sql`INSERT INTO projection_projects ${volatile.sql.insert(row)}`;
  });
  const emit = (type: StorageChange["type"], ids: ReadonlyArray<ThreadId>, generation: string) =>
    PubSub.publish(changeBus, { type, threadIds: ids, generation }).pipe(Effect.asVoid);
  const mapStorageError = (operation: string, threadId: ThreadId) => (cause: unknown) =>
    isTemporaryThreadStorageError(cause)
      ? cause
      : new TemporaryThreadStorageError({ operation, threadId, cause });
  const registerOwner = Effect.fn("TemporaryThreadStorage.registerOwner")(function* ({
    threadId,
    parentThreadId,
  }: Parameters<TemporaryThreadStorage["Service"]["register"]>[0]) {
    let entered = false;
    return yield* Effect.gen(function* () {
      if (
        owners.get(threadId)?.state === "discarded" ||
        (parentThreadId !== undefined && owners.get(parentThreadId)?.state === "discarded")
      )
        return yield* new TemporaryThreadStorageError({ operation: "discarded", threadId });
      if (owners.has(threadId)) return false;
      if (parentThreadId !== undefined && !temporary(parentThreadId)) return false;
      if (Option.isSome(diagnostics)) {
        diagnostics.value.enter(threadId);
        entered = true;
      }
      const exists =
        yield* durable.sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      if (exists.length > 0) return yield* new TemporaryThreadAlreadyDurableError({ threadId });
      const parent = parentThreadId === undefined ? undefined : owners.get(parentThreadId);
      if (parent?.state === "discarding")
        return yield* new TemporaryThreadStorageError({ operation: "discarding", threadId });
      const generation = parent?.generation ?? nextGeneration();
      yield* mirrorProjects();
      owners.set(threadId, { root: parent?.root ?? threadId, state: "temporary", generation });
      return true;
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          if (entered && !temporary(threadId) && Option.isSome(diagnostics))
            diagnostics.value.leave(threadId, true);
        }),
      ),
      Effect.mapError((cause) =>
        cause._tag === "TemporaryThreadAlreadyDurableError"
          ? cause
          : mapStorageError("register", threadId)(cause),
      ),
    );
  });
  const storage = TemporaryThreadStorage.of({
    register: Effect.fn("TemporaryThreadStorage.register")((input) =>
      locked(
        registerOwner(input).pipe(
          Effect.tap((created) =>
            created
              ? emit("registered", [input.threadId], owners.get(input.threadId)!.generation)
              : Effect.void,
          ),
          Effect.asVoid,
        ),
      ),
    ),
    isTemporary: Effect.fn("TemporaryThreadStorage.isTemporary")((id) =>
      Effect.sync(() => temporary(id)),
    ),
    isDiscarded: Effect.fn("TemporaryThreadStorage.isDiscarded")((id) =>
      Effect.sync(() => owners.get(id)?.state === "discarded"),
    ),
    family: Effect.fn("TemporaryThreadStorage.family")((id) => Effect.sync(() => family(id))),
    subscribeThreadRunUpdates: Effect.fn("TemporaryThreadStorage.subscribeThreadRunUpdates")(
      function* (threadId, includeDelegatedWork = false) {
        const subscription = yield* PubSub.subscribe(changeBus);
        const events = yield* Effect.forEach(
          [
            "run.updated",
            "thread.deleted",
            ...(includeDelegatedWork
              ? (["subagent.updated", "provider-thread.updated"] as const)
              : []),
          ] as const,
          (eventType) => subscribeEvents({ threadId, eventType }),
        );
        return Stream.merge(
          Stream.mergeAll(events, { concurrency: "unbounded" }).pipe(Stream.as(undefined)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (change) =>
                change.threadIds.includes(threadId) &&
                (change.type === "kept" || change.type === "discarded"),
            ),
            Stream.takeUntil((change) => change.type === "discarded"),
            Stream.as(undefined),
          ),
        );
      },
    ),
    generation: Effect.fn("TemporaryThreadStorage.generation")((id) =>
      Effect.sync(() => owners.get(id)?.generation ?? "durable"),
    ),
    changes: Stream.fromPubSub(changeBus),
    markDiscarding: Effect.fn("TemporaryThreadStorage.markDiscarding")(function* (id) {
      yield* locked(
        Effect.gen(function* () {
          const ids = family(id);
          for (const key of ids) {
            const owner = owners.get(key)!;
            if (owner.state === "temporary") owner.state = "discarding";
          }
          yield* emit("discarding", ids, owners.get(id)?.generation ?? "durable");
        }),
      );
    }),

    keep: Effect.fn("TemporaryThreadStorage.keep")(function* ({ threadId, commandId }) {
      yield* locked(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const owner = owners.get(threadId);
            if (owner === undefined) {
              const exists =
                yield* durable.sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
              if (exists.length === 0)
                return yield* new TemporaryThreadStorageError({ operation: "not-found", threadId });
              return;
            }
            if (owner.state === "durable") {
              yield* retireFamily(owner.root);
              return;
            }
            if (owner.state !== "temporary")
              return yield* new TemporaryThreadStorageError({ operation: "unavailable", threadId });
            const ids = family(threadId);
            const rows = yield* familyRows(ids);
            const imported = yield* durable.sql.withTransaction(
              Effect.gen(function* () {
                const sequenceMap = new Map<number, number>([[0, 0]]);
                const events =
                  rows.find((table) => table.name === "orchestration_events")?.rows ?? [];
                for (const row of [...events].sort(
                  (a, b) => Number(a.sequence) - Number(b.sequence),
                )) {
                  const { sequence, ...rest } = row;
                  const payload = { ...(yield* decodeObject(rest.payload_json)) };
                  if (typeof payload.promptSequence === "number")
                    payload.promptSequence =
                      sequenceMap.get(payload.promptSequence) ?? payload.promptSequence;
                  if (wholeThreadEventTypes.has(String(rest.event_type))) delete payload.temporary;
                  const inserted = yield* durable.sql<{
                    sequence: number;
                  }>`INSERT INTO orchestration_events ${durable.sql.insert({ ...rest, payload_json: yield* encodeObject(payload) })} RETURNING sequence`;
                  sequenceMap.set(Number(sequence), inserted[0]!.sequence);
                }
                const latestRows = yield* durable.sql<{
                  sequence: number;
                }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events`;
                const latest = latestRows[0]!.sequence;
                for (const table of rows) {
                  if (table.name === "orchestration_events") continue;
                  for (const original of table.rows) {
                    const row = { ...original };
                    if (typeof row.result_sequence === "number")
                      row.result_sequence = sequenceMap.get(row.result_sequence) ?? latest;
                    if (
                      table.name === "orchestration_v2_projection_threads" &&
                      typeof row.payload_json === "string"
                    ) {
                      const payload = { ...(yield* decodeObject(row.payload_json)) };
                      delete payload.temporary;
                      row.payload_json = yield* encodeObject(payload);
                    }
                    if (table.name === "orchestration_v2_projection_provider_sessions") {
                      const existing =
                        yield* durable.sql<Row>`SELECT * FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id = ${row.provider_session_id}`;
                      if (existing[0] !== undefined) {
                        const saved = yield* decodeProviderSession(existing[0].payload_json);
                        const incoming = yield* decodeProviderSession(row.payload_json);
                        if (
                          saved.id !== incoming.id ||
                          saved.driver !== incoming.driver ||
                          saved.providerInstanceId !== incoming.providerInstanceId ||
                          !saved.capabilities.sessions.supportsMultipleProviderThreadsPerSession ||
                          !incoming.capabilities.sessions.supportsMultipleProviderThreadsPerSession
                        )
                          return yield* new TemporaryThreadStorageError({
                            operation: "provider-session-conflict",
                            threadId,
                          });
                        yield* durable.sql`UPDATE orchestration_v2_projection_provider_sessions SET ${durable.sql.update(row)} WHERE provider_session_id = ${row.provider_session_id}`;
                        continue;
                      }
                    }
                    yield* durable.sql`INSERT INTO ${durable.sql(table.name)} ${durable.sql.insert(row)}`;
                  }
                }
                const now = DateTime.formatIso(yield* DateTime.now);
                yield* durable.sql`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error, command_type) VALUES (${commandId}, 'thread', ${threadId}, ${now}, ${latest}, 'accepted', NULL, 'thread.keep')`;
                yield* durable.sql`UPDATE orchestration_v2_projection_metadata SET last_sequence = ${latest}, updated_at = ${now} WHERE projection_name = 'thread-projections'`;
                const shells = yield* Effect.forEach(ids, (id) =>
                  durable.eventStore
                    .read({ threadId: id, eventType: "thread.created", limit: 1 })
                    .pipe(Stream.runCollect),
                );
                return { shells: shells.flat(), latest };
              }),
            );
            const generation = nextGeneration();
            generationCursors.set(generation, imported.latest);
            for (const id of ids) {
              const item = owners.get(id)!;
              item.state = "durable";
              item.generation = generation;
              if (Option.isSome(diagnostics)) diagnostics.value.leave(id, true);
            }
            pendingRetirements.set(owner.root, ids);
            yield* retireFamily(owner.root);
            yield* durable.applicationEvents.publishCommitted(imported.shells);
            yield* emit("kept", ids, generation);
          }),
        ),
      ).pipe(Effect.mapError(mapStorageError("keep", threadId)));
    }),
    discard: Effect.fn("TemporaryThreadStorage.discard")(function* (threadId) {
      yield* locked(
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (!temporary(threadId)) return;
            const ids = family(threadId);
            yield* volatile.sql.withTransaction(clearFamily(ids));
            const generation = nextGeneration();
            for (const id of ids) {
              const owner = owners.get(id)!;
              owner.state = "discarded";
              owner.generation = generation;
              if (Option.isSome(diagnostics)) diagnostics.value.leave(id);
            }
            yield* emit("discarded", ids, generation);
          }),
        ),
      ).pipe(Effect.mapError(mapStorageError("discard", threadId)));
    }),
  });

  const markTemporary = (event: OrchestrationV2DomainEvent): OrchestrationV2DomainEvent => {
    if (!isWholeThreadEvent(event)) return event;
    if (temporary(event.threadId))
      return { ...event, payload: { ...event.payload, temporary: true } };
    if ("temporary" in event.payload) {
      const { temporary: _, ...payload } = event.payload;
      return { ...event, payload };
    }
    return event;
  };
  const eventIds = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
    events.map((event) => event.threadId);
  const sinkError = (cause: unknown) => new EventSink.EventSinkWriteError({ eventCount: 0, cause });
  const writeSink = <A, E>(
    ids: ReadonlyArray<ThreadId>,
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
    use: (s: RawStores) => Effect.Effect<A, E>,
  ) => {
    const registered: Array<ThreadId> = [];
    const forget = (id: ThreadId) => {
      owners.delete(id);
      if (Option.isSome(diagnostics)) diagnostics.value.leave(id, true);
    };
    return locked(
      Effect.gen(function* () {
        for (const event of events) {
          if (event.type !== "thread.created") continue;
          const parentThreadId = event.payload.lineage.parentThreadId;
          if (
            event.payload.temporary === true ||
            (parentThreadId !== null && owners.has(parentThreadId))
          ) {
            if (
              yield* registerOwner({
                threadId: event.threadId,
                ...(parentThreadId === null ? {} : { parentThreadId }),
              })
            )
              registered.push(event.threadId);
          }
        }
        const result = yield* assertWritable(ids).pipe(Effect.flatMap(use));
        for (const id of registered) {
          if ((yield* volatile.projectionStore.getThreadShell(id)) === null) forget(id);
          else yield* emit("registered", [id], owners.get(id)!.generation);
        }
        return result;
      }).pipe(
        Effect.onError(() => Effect.sync(() => registered.forEach(forget))),
        Effect.uninterruptible,
      ),
    ).pipe(Effect.mapError(sinkError));
  };
  const assertCommandOwner = Effect.fn("TemporaryThreadStorage.assertCommandOwner")(function* (
    stores: RawStores,
    commandId: CommandId,
    threadId: ThreadId,
  ) {
    for (const candidate of [durable, volatile]) {
      const existing = yield* candidate.applicationReceipts.getByCommandId({ commandId });
      if (
        Option.isSome(existing) &&
        !(
          candidate === volatile &&
          existing.value.aggregateKind === "thread" &&
          !temporary(ThreadId.make(existing.value.aggregateId))
        ) &&
        (candidate !== stores ||
          existing.value.aggregateKind !== "thread" ||
          existing.value.aggregateId !== threadId)
      ) {
        return yield* new TemporaryThreadStorageError({ operation: "command-collision", threadId });
      }
    }
  });
  const nativeOwnedElsewhere = Effect.fn("TemporaryThreadStorage.nativeOwnedElsewhere")(function* (
    stores: RawStores,
    imported: Parameters<EventSink.EventSinkV2["Service"]["write"]>[0]["unlessNativeThreadOwned"],
  ) {
    if (imported?.nativeThreadRef == null) return false;
    const sql = (stores === durable ? volatile : durable).sql;
    const rows =
      yield* sql`SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
      WHERE driver = ${imported.driver} AND provider_instance_id = ${imported.providerInstanceId}
      AND thread_id IS NOT ${imported.appThreadId}
      AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${imported.nativeThreadRef.nativeId} LIMIT 1`;
    return rows.length > 0;
  });
  const eventSink = EventSink.EventSinkV2.of({
    write: Effect.fnUntraced(function* (input) {
      return yield* writeSink(eventIds(input.events), input.events, (s) =>
        nativeOwnedElsewhere(s, input.unlessNativeThreadOwned).pipe(
          Effect.flatMap((owned) =>
            owned
              ? Effect.succeed([])
              : s.eventSink.write({ ...input, events: input.events.map(markTemporary) }),
          ),
        ),
      );
    }),
    writeWithEffects: Effect.fnUntraced(function* (input) {
      return yield* writeSink(
        [...eventIds(input.events), ...input.effects.map((e) => e.threadId)],
        input.events,
        (s) =>
          nativeOwnedElsewhere(s, input.unlessNativeThreadOwned).pipe(
            Effect.flatMap((owned) =>
              owned
                ? Effect.succeed([])
                : s.eventSink.writeWithEffects({
                    ...input,
                    events: input.events.map(markTemporary),
                  }),
            ),
          ),
      );
    }),
    writeIfRunCurrent: Effect.fnUntraced(function* (input) {
      return yield* writeSink(
        [
          input.threadId,
          ...eventIds(input.events),
          ...(input.effects ?? []).map((e) => e.threadId),
        ],
        input.events,
        (s) => s.eventSink.writeIfRunCurrent({ ...input, events: input.events.map(markTemporary) }),
      );
    }),
    writeIfProviderThreadOwner: Effect.fnUntraced(function* (input) {
      return yield* writeSink(eventIds(input.events), input.events, (s) =>
        Effect.gen(function* () {
          const owner = yield* providerTarget(input.providerThreadId);
          if (input.events.length > 0 && owner !== s)
            return yield* new TemporaryThreadStorageError({
              operation: "mixed-provider-store",
              threadId: input.events[0]!.threadId,
            });
          return yield* owner.eventSink.writeIfProviderThreadOwner({
            ...input,
            events: input.events.map(markTemporary),
          });
        }),
      );
    }),
    writeIfProviderThreadUnchanged: Effect.fnUntraced(function* (input) {
      return yield* writeSink(
        [
          ...(input.expected.appThreadId === null ? [] : [input.expected.appThreadId]),
          ...eventIds(input.events),
        ],
        input.events,
        (s) =>
          s.eventSink.writeIfProviderThreadUnchanged({
            ...input,
            events: input.events.map(markTemporary),
          }),
      );
    }),
    commitCommand: Effect.fnUntraced(function* (input) {
      return yield* writeSink(
        [input.threadId, ...eventIds(input.events), ...input.effects.map((e) => e.threadId)],
        input.events,
        (stores) =>
          assertCommandOwner(stores, input.commandId, input.threadId).pipe(
            Effect.andThen(
              stores.eventSink.commitCommand({
                ...input,
                events: input.events.map(markTemporary),
              }),
            ),
          ),
      );
    }),
    commitRejectedCommand: Effect.fnUntraced(function* (input) {
      return yield* writeSink([input.threadId], [], (s) =>
        assertCommandOwner(s, input.commandId, input.threadId).pipe(
          Effect.andThen(s.eventSink.commitRejectedCommand(input)),
        ),
      );
    }),
    commitProjectCommand: Effect.fnUntraced(function* (input) {
      return yield* locked(
        durable.eventSink.commitProjectCommand(input).pipe(
          Effect.tap(() => mirrorProjects()),
          Effect.mapError(sinkError),
        ),
      );
    }),
    commitRejectedProjectCommand: Effect.fnUntraced(function* (input) {
      return yield* locked(durable.eventSink.commitRejectedProjectCommand(input));
    }),
    latestSequence: Effect.fnUntraced(function* (input) {
      return yield* locked(
        Effect.suspend(() => target(input?.threadId).eventSink.latestSequence(input)),
      );
    }),
    readByCommandId: (input) =>
      Stream.unwrap(
        commandTarget(input.commandId).pipe(
          Effect.map((s) => s.eventSink.readByCommandId(input)),
          Effect.mapError((cause) => new EventSink.EventSinkStreamError({ cause })),
        ),
      ),
    stream: (input) =>
      input?.threadId === undefined
        ? Stream.merge(
            durable.eventSink.stream(input),
            Stream.unwrap(
              volatile.eventSink.latestSequence().pipe(
                Effect.map((afterSequence) =>
                  volatile.eventSink.stream({
                    afterSequence,
                    ...(input?.eventType === undefined ? {} : { eventType: input.eventType }),
                  }),
                ),
              ),
            ),
          )
        : Stream.unwrap(
            subscribeEvents({
              ...input,
              threadId: input.threadId,
              afterSequence: input.afterSequence ?? 0,
            }),
          ),
  });
  const eventStore = EventStore.EventStoreV2.of({
    ...durable.eventStore,
    append: Effect.fnUntraced(function* (input) {
      return yield* withWrite(eventIds(input.events), (s) =>
        s.eventStore.append({ ...input, events: input.events.map(markTemporary) }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new EventStore.EventStoreAppendEventsError({ eventCount: input.events.length, cause }),
        ),
      );
    }),
    read: (input) =>
      Stream.unwrap(Effect.sync(() => target(input?.threadId).eventStore.read(input))),
    readByCommandId: (input) =>
      Stream.unwrap(
        commandTarget(input.commandId).pipe(
          Effect.map((s) => s.eventStore.readByCommandId(input)),
          Effect.mapError((cause) => new EventStore.EventStoreReadEventsError({ cause })),
        ),
      ),
    latestSequence: Effect.fnUntraced(function* (input) {
      return yield* locked(
        Effect.suspend(() => target(input?.threadId).eventStore.latestSequence(input)),
      );
    }),
    publishCommitted: Effect.fnUntraced(function* (events) {
      return yield* Effect.all(
        [
          durable.eventStore.publishCommitted(
            events.filter((e) => !("event" in e) || !temporary(e.event.threadId)),
          ),
          volatile.eventStore.publishCommitted(
            events.filter((e) => "event" in e && temporary(e.event.threadId)),
          ),
        ],
        { discard: true },
      );
    }),
  });

  const projectionStore = ProjectionStore.ProjectionStoreV2.of({
    ...durable.projectionStore,
    searchThreadStream: (input) =>
      Stream.unwrap(
        Effect.sync(() => target(input.threadId).projectionStore.searchThreadStream(input)),
      ),
    searchThread: Effect.fnUntraced(function* (input) {
      return yield* withThread(input.threadId, (s) => s.projectionStore.searchThread(input));
    }),
    apply: Effect.fnUntraced(function* (event) {
      return yield* withWrite([event.threadId], (s) =>
        s.projectionStore.apply(markTemporary(event)),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectionStore.ProjectionStoreApplyEventError({ eventType: event.type, cause }),
        ),
      );
    }),
    getTurnItem: Effect.fnUntraced(function* (input) {
      return yield* withThread(input.threadId, (s) => s.projectionStore.getTurnItem(input));
    }),
    isNodeStored: Effect.fnUntraced(function* (node) {
      return yield* withThread(node.threadId, (s) => s.projectionStore.isNodeStored(node));
    }),
    getThread: Effect.fnUntraced(function* (id) {
      return yield* withThread(id, (s) =>
        s.projectionStore
          .getThread(id)
          .pipe(Effect.map((thread) => (temporary(id) ? { ...thread, temporary: true } : thread))),
      );
    }),
    getThreadShell: Effect.fnUntraced(function* (id) {
      return yield* withThread(id, (s) =>
        s.projectionStore
          .getThreadShell(id)
          .pipe(
            Effect.map((thread) =>
              thread !== null && temporary(id) ? { ...thread, temporary: true } : thread,
            ),
          ),
      );
    }),
    getThreadAttachmentIds: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getThreadAttachmentIds(...args));
    }),
    getThreadHistoryPage: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getThreadHistoryPage(...args));
    }),
    getTimelinePage: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getTimelinePage(...args));
    }),
    getMessageCount: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getMessageCount(...args));
    }),
    getNextTurnItemOrdinal: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getNextTurnItemOrdinal(...args));
    }),
    getThreadRecords: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getThreadRecords(...args));
    }),
    getTurnStartContext: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getTurnStartContext(...args));
    }),
    getTurnStartHistory: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getTurnStartHistory(...args));
    }),
    getThreadProjection: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getThreadProjection(...args));
    }),
    getRuntimeRecoveryProjection: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) =>
        s.projectionStore.getRuntimeRecoveryProjection(...args),
      );
    }),
    getPendingNativeUserInputs: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) =>
        s.projectionStore.getPendingNativeUserInputs(...args),
      );
    }),
    getPlan: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getPlan(...args));
    }),
    hasUnpairedRunInterruptRequest: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) =>
        s.projectionStore.hasUnpairedRunInterruptRequest(...args),
      );
    }),
    getRuntimeRequest: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getRuntimeRequest(...args));
    }),
    getProviderControlContext: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) =>
        s.projectionStore.getProviderControlContext(...args),
      );
    }),
    getRunningTurnContext: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getRunningTurnContext(...args));
    }),
    getThreadProviderContext: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getThreadProviderContext(...args));
    }),
    getRuntimeResponseContext: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) =>
        s.projectionStore.getRuntimeResponseContext(...args),
      );
    }),
    getCheckpointContext: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getCheckpointContext(...args));
    }),
    getCheckpointCaptureContext: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) =>
        s.projectionStore.getCheckpointCaptureContext(...args),
      );
    }),
    getCheckpointRollbackContext: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) =>
        s.projectionStore.getCheckpointRollbackContext(...args),
      );
    }),
    getRunMessage: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getRunMessage(...args));
    }),
    canStartQueuedRun: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.canStartQueuedRun(...args));
    }),
    getThreadSnapshot: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getThreadSnapshot(...args));
    }),
    getThreadSnapshotWindow: Effect.fnUntraced(function* (...args) {
      return yield* withThread(args[0], (s) => s.projectionStore.getThreadSnapshotWindow(...args));
    }),
    listActiveSubagentThreadIds: Effect.fnUntraced(function* (...args) {
      return yield* locked(
        Effect.all([
          durable.projectionStore.listActiveSubagentThreadIds(...args),
          volatile.projectionStore.listActiveSubagentThreadIds(...args),
        ]).pipe(Effect.map(([disk, memory]) => [...disk, ...memory.filter((id) => temporary(id))])),
      );
    }),
    getLimitRecoveryCandidates: Effect.fnUntraced(function* (...args) {
      return yield* locked(
        Effect.all([
          durable.projectionStore.getLimitRecoveryCandidates(...args),
          volatile.projectionStore.getLimitRecoveryCandidates(...args),
        ]).pipe(
          Effect.map(([disk, memory]) => [...disk, ...memory.filter((row) => temporary(row.id))]),
        ),
      );
    }),
    getThreadWorktreePaths: Effect.fnUntraced(function* (...args) {
      return yield* locked(
        Effect.all([
          durable.projectionStore.getThreadWorktreePaths(...args),
          volatile.projectionStore.getThreadWorktreePaths(...args),
        ]).pipe(
          Effect.map(([disk, memory]) => [
            ...disk,
            ...memory.filter((row) => temporary(row.threadId)),
          ]),
        ),
      );
    }),
    getRecoveryThreadIds: Effect.fnUntraced(function* (...args) {
      return yield* locked(
        Effect.all([
          durable.projectionStore.getRecoveryThreadIds(...args),
          volatile.projectionStore.getRecoveryThreadIds(...args),
        ]).pipe(Effect.map(([disk, memory]) => [...disk, ...memory.filter((id) => temporary(id))])),
      );
    }),
    getUnreadableThreadIds: Effect.fnUntraced(function* (...args) {
      return yield* locked(
        Effect.all([
          durable.projectionStore.getUnreadableThreadIds(...args),
          volatile.projectionStore.getUnreadableThreadIds(...args),
        ]).pipe(Effect.map(([disk, memory]) => [...disk, ...memory.filter((id) => temporary(id))])),
      );
    }),
    getSettlementCandidates: Effect.fnUntraced(function* (id) {
      return yield* id === undefined
        ? locked(
            Effect.all([
              durable.projectionStore.getSettlementCandidates(),
              volatile.projectionStore.getSettlementCandidates(),
            ]).pipe(
              Effect.map(([disk, memory]) => [
                ...disk,
                ...memory.filter((row) => temporary(row.id)),
              ]),
            ),
          )
        : withThread(id, (s) => s.projectionStore.getSettlementCandidates(id));
    }),
    getThreadsWithPullRequests: Effect.fnUntraced(function* (id) {
      return yield* id === undefined
        ? locked(
            Effect.all([
              durable.projectionStore.getThreadsWithPullRequests(),
              volatile.projectionStore.getThreadsWithPullRequests(),
            ]).pipe(
              Effect.map(([disk, memory]) => [
                ...disk,
                ...memory.filter((row) => temporary(row.id)),
              ]),
            ),
          )
        : withThread(id, (s) => s.projectionStore.getThreadsWithPullRequests(id));
    }),

    getShellSnapshot: Effect.fnUntraced(function* (options) {
      return yield* locked(
        Effect.all([
          durable.projectionStore.getShellSnapshot(options),
          volatile.projectionStore.getShellSnapshot(options),
        ]).pipe(
          Effect.map(([disk, memory]) => ({
            ...disk,
            threads: [
              ...disk.threads,
              ...memory.threads
                .filter((t) => temporary(t.id))
                .map((t) => ({ ...t, temporary: true })),
            ],
            archivedThreads: [
              ...disk.archivedThreads,
              ...memory.archivedThreads
                .filter((t) => temporary(t.id))
                .map((t) => ({ ...t, temporary: true })),
            ],
          })),
        ),
      );
    }),
    readShellSnapshot: Effect.fnUntraced(function* (options) {
      return yield* projectionStore.getShellSnapshot(options).pipe(Effect.map(Effect.succeed));
    }),
  });
  const applicationReceipts = ApplicationReceipts.OrchestrationCommandReceiptRepository.of({
    insertIfAbsent: Effect.fnUntraced(function* (receipt) {
      return yield* (
        receipt.aggregateKind === "thread"
          ? withWrite([ThreadId.make(receipt.aggregateId)], (s) =>
              s.applicationReceipts.insertIfAbsent(receipt),
            )
          : locked(durable.applicationReceipts.insertIfAbsent(receipt))
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PersistenceSqlError({ operation: "TemporaryThreadStorage.receiptWrite", cause }),
        ),
      );
    }),
    upsert: Effect.fnUntraced(function* (receipt) {
      return yield* (
        receipt.aggregateKind === "thread"
          ? withWrite([ThreadId.make(receipt.aggregateId)], (s) =>
              s.applicationReceipts.upsert(receipt),
            )
          : locked(durable.applicationReceipts.upsert(receipt))
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PersistenceSqlError({ operation: "TemporaryThreadStorage.receiptWrite", cause }),
        ),
      );
    }),
    getByCommandId: Effect.fnUntraced(function* (input) {
      return yield* locked(
        commandTarget(input.commandId).pipe(
          Effect.flatMap((s) => s.applicationReceipts.getByCommandId(input)),
        ),
      );
    }),
  });
  const commandReceipts = CommandReceiptStore.CommandReceiptStoreV2.of({
    insertIfAbsent: Effect.fnUntraced(function* (receipt) {
      return yield* (
        "threadId" in receipt
          ? withWrite([receipt.threadId], (s) => s.commandReceipts.insertIfAbsent(receipt))
          : locked(durable.commandReceipts.insertIfAbsent(receipt))
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CommandReceiptStore.CommandReceiptStoreWriteError({
              commandId: receipt.commandId,
              cause,
            }),
        ),
      );
    }),
    upsert: Effect.fnUntraced(function* (receipt) {
      return yield* (
        "threadId" in receipt
          ? withWrite([receipt.threadId], (s) => s.commandReceipts.upsert(receipt))
          : locked(durable.commandReceipts.upsert(receipt))
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CommandReceiptStore.CommandReceiptStoreWriteError({
              commandId: receipt.commandId,
              cause,
            }),
        ),
      );
    }),
    getByCommandId: Effect.fnUntraced(function* (commandId) {
      return yield* locked(
        commandTarget(commandId).pipe(
          Effect.flatMap((s) => s.commandReceipts.getByCommandId(commandId)),
          Effect.mapError(
            (cause) => new CommandReceiptStore.CommandReceiptStoreReadError({ commandId, cause }),
          ),
        ),
      );
    }),
    getProjectByCommandId: Effect.fnUntraced(function* (commandId) {
      return yield* locked(durable.commandReceipts.getProjectByCommandId(commandId));
    }),
  });
  const turnItemPositions = TurnItemPositionStore.TurnItemPositionStoreV2.of({
    allocate: Effect.fnUntraced(function* (input) {
      return yield* withWrite([input.threadId], (s) => s.turnItemPositions.allocate(input)).pipe(
        Effect.mapError(
          (cause) => new TurnItemPositionStore.TurnItemPositionStoreError({ ...input, cause }),
        ),
      );
    }),
    normalize: Effect.fnUntraced(function* (item, ordinal) {
      return yield* withWrite([item.threadId], (s) =>
        s.turnItemPositions.normalize(item, ordinal),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TurnItemPositionStore.TurnItemPositionStoreError({
              threadId: item.threadId,
              turnItemId: item.id,
              cause,
            }),
        ),
      );
    }),
  });
  let claimVolatile = false;
  const outboxError = (cause: unknown) =>
    new EffectOutbox.EffectOutboxError({ operation: "route", cause });
  const effectOutbox = EffectOutbox.EffectOutboxV2.of({
    ...durable.effectOutbox,
    enqueue: Effect.fnUntraced(function* (effects) {
      return yield* withWrite(
        effects.map((e) => e.threadId),
        (s) => s.effectOutbox.enqueue(effects),
      ).pipe(Effect.mapError(outboxError));
    }),
    get: Effect.fnUntraced(function* (id) {
      return yield* locked(effectTarget(id).pipe(Effect.flatMap((s) => s.effectOutbox.get(id))));
    }),
    listByCommandId: Effect.fnUntraced(function* (id) {
      return yield* locked(
        Effect.all([
          durable.effectOutbox.listByCommandId(id),
          volatile.effectOutbox.listByCommandId(id),
        ]).pipe(
          Effect.map(([a, b]) => [...a, ...b.filter((effect) => temporary(effect.threadId))]),
        ),
      );
    }),
    cancelUnsettled: Effect.fnUntraced(function* (input) {
      return yield* withWrite([input.threadId], (s) => s.effectOutbox.cancelUnsettled(input)).pipe(
        Effect.mapError(outboxError),
      );
    }),
    claimNext: Effect.fnUntraced(function* (input) {
      claimVolatile = !claimVolatile;
      const first = claimVolatile ? volatile : durable;
      const second = claimVolatile ? durable : volatile;
      const found = yield* first.effectOutbox.claimNext(input);
      return Option.isSome(found) ? found : yield* second.effectOutbox.claimNext(input);
    }, locked),
    nextClaimableAt: locked(
      Effect.all([
        durable.effectOutbox.nextClaimableAt,
        volatile.effectOutbox.nextClaimableAt,
      ]).pipe(
        Effect.map(([a, b]) =>
          Option.isNone(a)
            ? b
            : Option.isNone(b)
              ? a
              : DateTime.toEpochMillis(a.value) <= DateTime.toEpochMillis(b.value)
                ? a
                : b,
        ),
      ),
    ),
    awaitSettled: Effect.fn("TemporaryThreadStorage.awaitSettled")(function* (id) {
      const signal = signals.settledSignals.get(id) ?? Deferred.makeUnsafe<void>();
      signals.settledSignals.set(id, signal);
      const row = yield* effectOutbox.get(id);
      if (Option.exists(row, (e) => e.status === "pending" || e.status === "running"))
        yield* Deferred.await(signal);
      else {
        signals.settledSignals.delete(id);
        yield* Deferred.succeed(signal, undefined);
      }
    }),
    succeed: Effect.fnUntraced(function* (input) {
      return yield* locked(
        effectTarget(input.effectId).pipe(Effect.flatMap((s) => s.effectOutbox.succeed(input))),
      );
    }),
    retry: Effect.fnUntraced(function* (input) {
      return yield* locked(
        effectTarget(input.effectId).pipe(Effect.flatMap((s) => s.effectOutbox.retry(input))),
      );
    }),
    fail: Effect.fnUntraced(function* (input) {
      return yield* locked(
        effectTarget(input.effectId).pipe(Effect.flatMap((s) => s.effectOutbox.fail(input))),
      );
    }),
  });
  const applicationEvents = ApplicationEvents.OrchestrationEventStore.of({
    ...durable.applicationEvents,
    appendAgentEvents: Effect.fnUntraced(function* (input) {
      return yield* withWrite(eventIds(input.events), (s) =>
        s.applicationEvents.appendAgentEvents({
          ...input,
          events: input.events.map(markTemporary),
        }),
      ).pipe(
        Effect.mapError(
          (cause) => new PersistenceSqlError({ operation: "TemporaryThreadStorage.append", cause }),
        ),
      );
    }),
    readAgentEvents: (input) =>
      Stream.unwrap(
        input?.commandId === undefined
          ? Effect.sync(() => target(input?.threadId).applicationEvents.readAgentEvents(input))
          : commandTarget(input.commandId).pipe(
              Effect.map((s) => s.applicationEvents.readAgentEvents(input)),
            ),
      ),
    latestAgentSequence: Effect.fnUntraced(function* (id) {
      return yield* locked(
        Effect.suspend(() => target(id).applicationEvents.latestAgentSequence(id)),
      );
    }),
    getAgentReplayStats: Effect.fnUntraced(function* (input) {
      return yield* withThread(input.threadId, (s) =>
        s.applicationEvents.getAgentReplayStats(input),
      );
    }),
    publishCommitted: eventStore.publishCommitted,
  });
  const providerSessionRuntime = ProviderSessionRuntime.ProviderSessionRuntimeRepository.of({
    upsert: Effect.fnUntraced(function* (input, options) {
      return yield* withWrite([input.threadId], (s) =>
        s.providerSessionRuntime.upsert(input, options),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PersistenceSqlError({ operation: "TemporaryThreadStorage.runtimeUpsert", cause }),
        ),
      );
    }),
    recordImportedTranscript: Effect.fnUntraced(function* (input) {
      return yield* withWrite([input.threadId], (s) =>
        s.providerSessionRuntime.recordImportedTranscript(input),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PersistenceSqlError({ operation: "TemporaryThreadStorage.runtimeImport", cause }),
        ),
      );
    }),
    getByThreadId: Effect.fnUntraced(function* (input) {
      return yield* withThread(input.threadId, (s) =>
        s.providerSessionRuntime.getByThreadId(input),
      );
    }),
    deleteByThreadId: Effect.fnUntraced(function* (input) {
      return yield* withWrite([input.threadId], (s) =>
        s.providerSessionRuntime.deleteByThreadId(input),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PersistenceSqlError({ operation: "TemporaryThreadStorage.runtimeDelete", cause }),
        ),
      );
    }),
    list: Effect.fnUntraced(function* (options) {
      return yield* locked(
        Effect.all([
          durable.providerSessionRuntime.list(options),
          volatile.providerSessionRuntime.list(options),
        ]).pipe(
          Effect.map(([a, b]) => [...a, ...b.filter((effect) => temporary(effect.threadId))]),
        ),
      );
    }),
  });
  return Context.empty().pipe(
    Context.add(TemporaryThreadStorage, storage),
    Context.add(TemporaryThreadStores, { durable, volatile, getShellSnapshot }),
    Context.add(ProjectStore.ProjectStoreV2, durable.projectStore),
    Context.add(EventSink.EventSinkV2, eventSink),
    Context.add(EventStore.EventStoreV2, eventStore),
    Context.add(ProjectionStore.ProjectionStoreV2, projectionStore),
    Context.add(CommandReceiptStore.CommandReceiptStoreV2, commandReceipts),
    Context.add(ApplicationReceipts.OrchestrationCommandReceiptRepository, applicationReceipts),
    Context.add(TurnItemPositionStore.TurnItemPositionStoreV2, turnItemPositions),
    Context.add(EffectOutbox.EffectOutboxV2, effectOutbox),
    Context.add(ApplicationEvents.OrchestrationEventStore, applicationEvents),
    Context.add(ProviderSessionRuntime.ProviderSessionRuntimeRepository, providerSessionRuntime),
  );
});

export const layer = Layer.effectContext(make);

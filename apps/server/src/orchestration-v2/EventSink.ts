import {
  CommandId,
  type ClaudeSessionIdentityPlan,
  type ClaudeSessionBlocker,
  ProviderDriverKind,
  EventId,
  OrchestrationV2AppThread,
  type ProviderOptionSelections,
  type OrchestrationV2Run,
  OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  OrchestrationV2StoredEvent,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  NodeId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";

import { replayAndBufferProjectedLiveEvents } from "./LiveStreamBudget.ts";
import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";
import { makeRunOutcomeRecorder, type RunOutcome } from "./RunMetrics.ts";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import {
  nativeCommandCategory,
  nativeCommandOwners,
  claudeThreadSettingsFit,
} from "./NativeSessionPolicy.ts";
import { deriveProviderThread } from "@t3tools/provider-core/server/IdAllocator";
import { ClaudeEnrollment, ClaudeHistory, ClaudeOperation } from "./ClaudeSessionJournal.ts";
import { canonicalClaudeJson } from "../claudeSessionSnapshot.ts";

export const NativeCommandAdmission = Context.Reference<
  { readonly threadId: ThreadId; readonly epoch: number | null } | undefined
>("t3/orchestration-v2/NativeCommandAdmission", { defaultValue: () => undefined });
const threadPolicyKeys = [
  "id",
  "projectId",
  "providerInstanceId",
  "modelSelection",
  "runtimeMode",
  "interactionMode",
  "worktreePath",
  "activeProviderThreadId",
  "archivedAt",
  "deletedAt",
] as const;
const threadPolicySchema = Schema.Struct(
  Struct.pick(OrchestrationV2AppThread.fields, threadPolicyKeys),
);
const sameThreadPolicy = Schema.toEquivalence(threadPolicySchema);
export interface ThreadProjectionCommit {
  readonly expected: typeof threadPolicySchema.Type;
  readonly modelOptionsUpdate?: {
    readonly eventId: EventId;
    readonly occurredAt: DateTime.Utc;
    readonly options: ProviderOptionSelections;
  };
}
const isThreadEvent = (
  event: OrchestrationV2DomainEvent,
): event is Extract<OrchestrationV2DomainEvent, { readonly payload: OrchestrationV2AppThread }> =>
  event.type.startsWith("thread.") && "runtimeMode" in event.payload;

export class EventSinkWriteError extends Schema.TaggedError<EventSinkWriteError>()(
  "EventSinkWriteError",
  {
    eventCount: Schema.Number,
    commandId: Schema.optional(CommandId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventSinkStreamError extends Schema.TaggedError<EventSinkStreamError>()(
  "EventSinkStreamError",
  {
    threadId: Schema.optional(ThreadId),
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to stream orchestration V2 events."
      : `Failed to stream orchestration V2 events for thread ${this.threadId}.`;
  }
}

export const EventSinkV2Error = Schema.Union([EventSinkWriteError, EventSinkStreamError]);
export type EventSinkV2Error = typeof EventSinkV2Error.Type;

export interface EventSinkV2Shape {
  readonly checkClaudeSessionTarget: (
    plan: ClaudeSessionIdentityPlan,
  ) => Effect.Effect<ClaudeSessionBlocker["code"] | null, EventSinkV2Error>;
  readonly commitClaudeSession: (input: {
    readonly expectedRevision: number | null;
    readonly expectedSequence: number;
    readonly expectedThread?: ThreadProjectionCommit["expected"];
    readonly enrollment: ClaudeEnrollment;
    readonly operation: ClaudeOperation;
    readonly history?: ClaudeHistory;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<boolean, EventSinkV2Error>;
  readonly write: (input: {
    readonly threadCommit?: ThreadProjectionCommit;
    /** Return no events if another thread owns this native session at commit time. */
    readonly unlessNativeThreadOwned?: Pick<
      OrchestrationV2ProviderThread,
      "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeWithEffects: (input: {
    readonly threadCommit?: ThreadProjectionCommit;
    /**
     * Rebuilds each run.updated from the stored row with only its delegatedCompletion replaced.
     * The batch must not also change that run's lifecycle.
     */
    readonly updateDelegatedCompletionOnly?: boolean;
    readonly unlessNativeThreadOwned?: Pick<
      OrchestrationV2ProviderThread,
      "driver" | "providerInstanceId" | "appThreadId" | "nativeThreadRef"
    >;
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeIfRunCurrent: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedStatus: OrchestrationV2Run["status"];
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects?: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /** Commits only if the expected attempt and ordinal still own the provider thread, protecting newer attempts. */
  readonly writeIfProviderThreadOwner: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly providerThreadId: ProviderThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedLastRunOrdinal: number;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /** Commits only if the full provider row equals expected; some writers do not advance updatedAt. */
  readonly writeIfProviderThreadUnchanged: (input: {
    readonly expected: OrchestrationV2ProviderThread;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly commitCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
  }) => Effect.Effect<
    {
      readonly receipt: CommandReceiptStore.CommandReceiptV2;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
      readonly committed: boolean;
      readonly cancelledEffectCount: number;
    },
    EventSinkV2Error
  >;
  readonly commitRejectedCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.CommandReceiptV2, EventSinkV2Error>;
  readonly commitProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly event: UnsequencedProjectEvent;
  }) => Effect.Effect<
    { readonly receipt: CommandReceiptStore.ProjectCommandReceiptV2; readonly committed: boolean },
    EventSinkV2Error
  >;
  readonly commitRejectedProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.ProjectCommandReceiptV2, EventSinkV2Error>;
  readonly stream: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    /** Bound RPC subscribers; internal workers must not drop their subscription under load. */
    readonly bounded?: boolean;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventSinkV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
}

export class EventSinkV2 extends Context.Service<EventSinkV2, EventSinkV2Shape>()(
  "t3/orchestration-v2/EventSink/EventSinkV2",
) {}

const layerBase: Layer.Layer<
  EventSinkV2,
  never,
  | CommandReceiptStore.CommandReceiptStoreV2
  | EffectOutbox.EffectOutboxV2
  | EventStore.EventStoreV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | SqlClient.SqlClient
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    const liveEventsByType = new Map<
      OrchestrationV2DomainEvent["type"],
      PubSub.PubSub<OrchestrationV2StoredEvent>
    >();
    const claudeBindingOwned = Effect.fn("EventSink.claudeBindingOwned")(function* (
      plan: ClaudeSessionIdentityPlan,
    ) {
      const providerId = deriveProviderThread({
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: plan.providerInstanceId,
        nativeThreadId: plan.nativeId,
      });
      const rows = yield* sql`
        SELECT thread_id FROM orchestration_v2_projection_provider_threads
        WHERE thread_id IS NOT ${plan.threadId} AND
          (provider_thread_id = ${providerId} OR (driver = 'claudeAgent' AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${plan.nativeId}))
        UNION ALL
        SELECT thread_id FROM orchestration_v2_claude_sessions
        WHERE thread_id <> ${plan.threadId} AND native_id = ${plan.nativeId}
        UNION ALL
        SELECT thread_id FROM orchestration_v2_native_sessions WHERE thread_id = ${plan.threadId}
      `;
      return rows.length > 0;
    });
    const claudeSessionWorkActive = Effect.fn("EventSink.claudeSessionWorkActive")(function* (
      threadId: ThreadId,
    ) {
      const work = yield* sql`
        SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId} AND status IN ('pending', 'running')
        UNION ALL SELECT task_id FROM scheduled_tasks WHERE thread_id = ${threadId} AND enabled = 1
        UNION ALL SELECT write_id FROM orchestration_v2_claude_writes WHERE thread_id = ${threadId} AND state <> 'settled'
        UNION ALL SELECT generation_id FROM orchestration_v2_claude_generations WHERE thread_id = ${threadId} AND state <> 'exited'
      `.pipe(Effect.mapError((cause) => new EventSinkWriteError({ eventCount: 0, cause })));
      return work.length > 0;
    });
    const checkClaudeSessionTarget = Effect.fn("EventSink.checkClaudeSessionTarget")(function* (
      plan: ClaudeSessionIdentityPlan,
    ): Effect.fn.Return<ClaudeSessionBlocker["code"] | null, EventSinkV2Error> {
      if (
        yield* claudeBindingOwned(plan).pipe(
          Effect.mapError((cause) => new EventSinkWriteError({ eventCount: 0, cause })),
        )
      )
        return "native-binding-owned";
      const target = yield* projectionStore.getThreadProjection(plan.threadId).pipe(
        Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
        Effect.mapError((cause) => new EventSinkWriteError({ eventCount: 0, cause })),
      );
      if (target !== null) {
        if (target.thread.projectId !== plan.projectId) return "scope-mismatch";
        if (
          target.thread.activeProviderThreadId !== null ||
          target.thread.deletedAt !== null ||
          target.thread.archivedAt !== null ||
          target.thread.forkedFrom !== null ||
          target.messages.length > 0 ||
          target.turnItems.length > 0 ||
          target.runs.length > 0 ||
          target.providerThreads.length > 0 ||
          target.providerSessions.length > 0 ||
          target.providerTurns.length > 0 ||
          target.runtimeRequests.length > 0 ||
          target.subagents.length > 0 ||
          target.nodes.length > 0 ||
          target.attempts.length > 0 ||
          target.contextTransfers.length > 0 ||
          target.contextHandoffs.length > 0 ||
          target.plans.length > 0 ||
          target.checkpoints.length > 0
        )
          return "target-not-empty";
        if (!claudeThreadSettingsFit(plan, target.thread)) return "settings-changed";
      }
      return (yield* claudeSessionWorkActive(plan.threadId)) ? "managed-work-active" : null;
    });
    const claudeBindingEventsConflict = Effect.fn("EventSink.claudeBindingEventsConflict")(
      function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
        for (const event of events) {
          if (event.type === "thread.created") {
            const reserved =
              yield* sql`SELECT thread_id FROM orchestration_v2_claude_sessions WHERE thread_id = ${event.threadId}`;
            if (reserved.length > 0) return true;
          }
          if (event.type !== "provider-thread.updated" || event.payload.driver !== "claudeAgent")
            continue;
          const provider = event.payload;
          const owners = yield* sql`
          SELECT thread_id FROM orchestration_v2_projection_provider_threads
          WHERE thread_id IS NOT ${provider.appThreadId} AND
            (provider_thread_id = ${provider.id} OR (driver = 'claudeAgent' AND provider_instance_id = ${provider.providerInstanceId} AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${provider.nativeThreadRef?.nativeId ?? null}))
          UNION ALL SELECT thread_id FROM orchestration_v2_claude_sessions
          WHERE (native_id = ${provider.nativeThreadRef?.nativeId ?? null} AND thread_id IS NOT ${provider.appThreadId})
            OR (thread_id = ${provider.appThreadId} AND (native_id IS NOT ${provider.nativeThreadRef?.nativeId ?? null} OR json_extract(payload_json, '$.plan.providerInstanceId') IS NOT ${provider.providerInstanceId}))
        `;
          if (owners.length > 0) return true;
        }
        return false;
      },
    );
    const publishLiveEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2StoredEvent>) {
        yield* PubSub.publishAll(liveEvents, events);
        for (const [type, pubsub] of liveEventsByType) {
          yield* PubSub.publishAll(
            pubsub,
            events.filter((stored) => stored.event.type === type),
          );
        }
      });
    const runOutcomes = makeRunOutcomeRecorder((threadId) =>
      // One payload row; unlike the shell, it still resolves a deleted child thread.
      projectionStore
        .getThread(threadId)
        .pipe(Effect.map((thread) => thread.lineage.relationshipToParent === "subagent")),
    );
    // Recorded before publication, so an interrupted publish cannot lose a committed outcome.
    const publishStoredEvents = (
      events: ReadonlyArray<OrchestrationV2StoredEvent>,
      outcomes: ReadonlyArray<RunOutcome>,
    ) =>
      runOutcomes
        .record(outcomes)
        .pipe(
          Effect.andThen(eventStore.publishCommitted(events)),
          Effect.andThen(publishLiveEvents(events)),
        );

    // Serialize commit and publish; reordered publication makes clients drop earlier sequences.
    const publishLane = yield* Semaphore.make(1);
    const commitThenPublish = <A, E, R>(
      transaction: Effect.Effect<A, E, R>,
      publish: (committed: A) => Effect.Effect<void>,
    ) =>
      Effect.uninterruptibleMask((restore) => {
        let holdsLane = false;
        const takeLane = publishLane.take(1).pipe(
          Effect.andThen(
            Effect.sync(() => {
              holdsLane = true;
            }),
          ),
          Effect.uninterruptible,
        );
        // Cancellation may roll back the transaction's work. Once it commits,
        // every subscriber must hear about it before this writer can exit.
        // Otherwise a failed child run can leave its parent's task running.
        return sql
          .withTransaction(Effect.tap(restore(transaction), () => takeLane))
          .pipe(
            Effect.tap(publish),
            Effect.ensuring(
              Effect.suspend(() => (holdsLane ? publishLane.release(1) : Effect.void)),
            ),
          );
      });

    // A user can answer after terminal normalization reads the pending request.
    // Recheck inside the write transaction so stale cleanup cannot erase answers.
    const guardUserInputCancellations =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
        const staleRequests = new Set<RuntimeRequestId>();
        const staleNodes = new Set<NodeId>();
        for (const event of events) {
          if (
            event.type !== "runtime-request.updated" ||
            event.payload.kind !== "user_input" ||
            event.payload.status !== "cancelled"
          )
            continue;
          const current = yield* projectionStore.getRuntimeRequest(
            event.threadId,
            event.payload.id,
          );
          if (
            current?.status !== "pending" ||
            current.kind !== "user_input" ||
            current.providerTurnId !== event.payload.providerTurnId ||
            current.responseCapability.type === "message"
          ) {
            staleRequests.add(event.payload.id);
            staleNodes.add(event.payload.nodeId);
          }
        }
        return events.filter((event) => {
          switch (event.type) {
            case "runtime-request.updated":
              return event.payload.status !== "cancelled" || !staleRequests.has(event.payload.id);
            case "node.updated":
              return event.payload.status !== "cancelled" || !staleNodes.has(event.payload.id);
            case "turn-item.updated":
              return (
                event.payload.type !== "user_input_request" ||
                event.payload.status !== "cancelled" ||
                !staleRequests.has(event.payload.requestId)
              );
            default:
              return true;
          }
        });
      });

    const normalizeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
      const nativePositions = new Map(
        events.flatMap((event) =>
          event.type === "native-session.updated" && event.payload.type === "history"
            ? event.payload.value.items.map((item) => [item.turnItemId, item.ordinal] as const)
            : [],
        ),
      );
      const runOrdinals = new Map(
        events.flatMap((event) =>
          event.type === "run.created" || event.type === "run.updated"
            ? [[event.payload.id, event.payload.ordinal] as const]
            : [],
        ),
      );
      return Effect.forEach(
        events,
        (event): Effect.Effect<OrchestrationV2DomainEvent, unknown> => {
          if (event.type !== "turn-item.updated") return Effect.succeed(event);
          const nativeOrdinal = nativePositions.get(event.payload.id);
          if (nativeOrdinal !== undefined)
            return Effect.succeed({
              ...event,
              payload: { ...event.payload, ordinal: nativeOrdinal },
            });
          return turnItemPositions
            .normalize(
              event.payload,
              event.payload.runId === null ? undefined : runOrdinals.get(event.payload.runId),
            )
            .pipe(Effect.map((payload) => ({ ...event, payload })));
        },
        { concurrency: 1 },
      );
    };

    const applyStoredEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) {
        yield* Effect.forEach(storedEvents, (stored) => projectionStore.apply(stored.event), {
          concurrency: 1,
        });
        const sequence = storedEvents.at(-1)?.sequence;
        if (sequence !== undefined) {
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${sequence},
              ${now}
            )
            ON CONFLICT(projection_name)
            DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }
        // Read lineage here, on the connection this transaction holds; see makeRunOutcomeRecorder.
        return yield* runOutcomes.prepare(storedEvents);
      });

    const writeEffect = Effect.fn("orchestrationV2.EventSink.write")(function* (
      input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0],
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.thread_id": input.events[0]?.threadId ?? null,
      });

      const { committed } = yield* commitThenPublish(
        Effect.gen(function* () {
          if (yield* claudeBindingEventsConflict(input.events))
            return { committed: [], outcomes: [] };
          const threadCommit = input.threadCommit;
          const threadEvents: Array<OrchestrationV2DomainEvent> = [];
          if (threadCommit !== undefined) {
            const current = yield* projectionStore.getThread(threadCommit.expected.id);
            if (!sameThreadPolicy(current, threadCommit.expected))
              return { committed: [], outcomes: [] };
            const update = threadCommit.modelOptionsUpdate;
            if (update !== undefined) {
              const replaced = new Set(update.options.map((option) => option.id));
              threadEvents.push({
                id: update.eventId,
                threadId: current.id,
                occurredAt: update.occurredAt,
                type: "thread.model-selection-updated",
                payload: {
                  ...current,
                  updatedAt: update.occurredAt,
                  modelSelection: {
                    ...current.modelSelection,
                    options: [
                      ...(current.modelSelection.options ?? []).filter(
                        (option) => !replaced.has(option.id),
                      ),
                      ...update.options,
                    ],
                  },
                },
              });
            }
          }
          // Check ownership in the same transaction that claims the native session.
          const imported = input.unlessNativeThreadOwned;
          if (imported?.nativeThreadRef != null) {
            const owners = yield* sql`
              SELECT provider_thread_id
              FROM orchestration_v2_projection_provider_threads
              WHERE driver = ${imported.driver}
                AND provider_instance_id = ${imported.providerInstanceId}
                AND thread_id IS NOT ${imported.appThreadId}
                AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${imported.nativeThreadRef.nativeId}
              LIMIT 1
            `;
            if (owners.length > 0) return { committed: [], outcomes: [] };
          }
          // Checkpoint capture can finish after a cohort writer reads its parent run.
          // Merge in this transaction so the event log and projection keep that completion.
          const events = input.updateDelegatedCompletionOnly
            ? yield* Effect.forEach(input.events, (event) =>
                Effect.gen(function* () {
                  if (event.type !== "run.updated") return event;
                  const { runs } = yield* projectionStore.getThreadRecords(
                    event.threadId,
                    ["runs"],
                    { runIds: [event.payload.id] },
                  );
                  const current = runs[0];
                  return current === undefined
                    ? event
                    : {
                        ...event,
                        payload: {
                          ...current,
                          delegatedCompletion: event.payload.delegatedCompletion,
                        },
                      };
                }),
              )
            : input.events;
          const projected = [...events, ...threadEvents];
          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(projected)
              : projected,
          );
          const committed = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          const outcomes = yield* applyStoredEvents(committed);
          yield* effectOutbox.enqueue(input.effects);
          return { committed, outcomes };
        }).pipe(Effect.withTracerEnabled(false)),
        ({ committed, outcomes }) =>
          Effect.gen(function* () {
            if (input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            yield* publishStoredEvents(committed, outcomes);
          }),
      );
      return committed;
    });

    const writeIfRunCurrentEffect = Effect.fn("orchestrationV2.EventSink.writeIfRunCurrent")(
      function* (input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]) {
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.command_id": input.commandId ?? null,
          "orchestration_v2.event_count": input.events.length,
          "orchestration_v2.run_id": input.runId,
          "orchestration_v2.thread_id": input.threadId,
        });

        return yield* commitThenPublish(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly status: string;
              readonly active_attempt_id: string | null;
            }>`
            SELECT
              status,
              json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id
            FROM orchestration_v2_projection_runs
            WHERE run_id = ${input.runId}
              AND thread_id = ${input.threadId}
            LIMIT 1
          `;
            const current = rows[0];
            if (
              current === undefined ||
              current.status !== input.expectedStatus ||
              current.active_attempt_id !== input.activeAttemptId
            ) {
              return {
                committed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
            }

            const normalized = yield* normalizeEvents(
              input.guardPendingUserInputCancellations === true
                ? yield* guardUserInputCancellations(input.events)
                : input.events,
            );
            const storedEvents = yield* eventStore.append({
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              events: normalized,
            });
            const outcomes = yield* applyStoredEvents(storedEvents);
            yield* effectOutbox.enqueue(input.effects ?? []);
            return { committed: true as const, storedEvents, outcomes };
          }),
          (result) =>
            Effect.gen(function* () {
              if (!result.committed) return;
              if (input.effects !== undefined && input.effects.length > 0) {
                yield* effectOutbox.notifyAvailable(input.effects.length);
              }
              yield* publishStoredEvents(result.storedEvents, result.outcomes);
            }),
        );
      },
    );

    const writeIfProviderThreadOwnerEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadOwner",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadOwner"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.providerThreadId,
        "orchestration_v2.run_id": input.runId,
        "orchestration_v2.active_attempt_id": input.activeAttemptId,
        "orchestration_v2.expected_last_run_ordinal": input.expectedLastRunOrdinal,
      });

      return yield* commitThenPublish(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly active_attempt_id: string | null;
            readonly last_run_ordinal: number | null;
          }>`
            SELECT
              json_extract(r.payload_json, '$.activeAttemptId') AS active_attempt_id,
              p.last_run_ordinal
            FROM orchestration_v2_projection_provider_threads p
            JOIN orchestration_v2_projection_runs r
              ON r.run_id = ${input.runId}
             AND r.thread_id = p.thread_id
            WHERE p.provider_thread_id = ${input.providerThreadId}
            LIMIT 1
          `;
          const current = rows[0];
          if (
            current === undefined ||
            current.active_attempt_id !== input.activeAttemptId ||
            current.last_run_ordinal !== input.expectedLastRunOrdinal
          ) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(input.events)
              : input.events,
          );
          const storedEvents = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          const outcomes = yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents, outcomes };
        }),
        (result) =>
          result.committed
            ? publishStoredEvents(result.storedEvents, result.outcomes)
            : Effect.void,
      );
    });

    const writeIfProviderThreadUnchangedEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadUnchanged",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadUnchanged"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.expected.id,
      });
      const expectedJson = yield* ProjectionStore.encodeProviderThreadPayload(input.expected);

      return yield* commitThenPublish(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${input.expected.id}
            LIMIT 1
          `;
          if (rows[0]?.payload_json !== expectedJson) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const normalized = yield* normalizeEvents(input.events);
          const storedEvents = yield* eventStore.append({ events: normalized });
          const outcomes = yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents, outcomes };
        }),
        (result) =>
          result.committed
            ? publishStoredEvents(result.storedEvents, result.outcomes)
            : Effect.void,
      );
    });

    const existingCommandResult =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (commandId: CommandId) {
        const existing = yield* commandReceipts.getByCommandId(commandId);
        if (Option.isNone(existing)) {
          return yield* Effect.die(
            new Error(`Command receipt ${commandId} disappeared during its transaction.`),
          );
        }
        const storedEvents = yield* eventStore.readByCommandId({ commandId }).pipe(
          Stream.runCollect,
          Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        );
        return { receipt: existing.value, storedEvents };
      });

    const commitCommandEffect = Effect.fn("orchestrationV2.EventSink.commitCommand")(function* (
      input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
    ) {
      const result = yield* commitThenPublish(
        Effect.gen(function* () {
          const reserved = yield* commandReceipts.insertIfAbsent({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: 0,
            status: "accepted",
            error: null,
          });
          if (!reserved) {
            const existing = yield* existingCommandResult(input.commandId);
            return { ...existing, committed: false as const, cancelledEffectIds: [] };
          }

          let events = input.events;
          const admission = yield* NativeCommandAdmission;
          const nativeScopes = [
            input.threadId,
            ...(admission === undefined ? [] : [admission.threadId]),
          ];
          const owners = yield* nativeCommandOwners(nativeScopes).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          const rows = owners.map(({ record }) => ({
            thread_id: record.threadId,
            controller: record.controller.type,
            epoch: record.controller.epoch,
          }));
          const bindingConflict = yield* claudeBindingEventsConflict(input.events);
          const selectedNative = rows.find((row) => row.thread_id === input.threadId);
          if (rows.length > 0 || bindingConflict) {
            const current =
              selectedNative === undefined
                ? undefined
                : yield* projectionStore.getThread(input.threadId).pipe(
                    Effect.catchTags({
                      ProjectionStoreThreadNotFoundError: () => Effect.succeed(undefined),
                    }),
                  );
            const workspaceChanged = input.events.some(
              (event) =>
                current !== undefined &&
                event.threadId === input.threadId &&
                isThreadEvent(event) &&
                event.payload.worktreePath !== current.worktreePath,
            );
            const category = nativeCommandCategory(input.commandType);
            let claudePolicyChanged = false;
            for (const owner of owners) {
              if (owner.provider !== "claude" || category !== "controlled") continue;
              const thread = yield* projectionStore.getThread(owner.record.threadId).pipe(
                Effect.catchTags({
                  ProjectionStoreThreadNotFoundError: () => Effect.succeed(undefined),
                }),
              );
              const pending =
                yield* sql`SELECT write_id FROM orchestration_v2_claude_writes WHERE thread_id = ${owner.record.threadId} AND state <> 'settled' LIMIT 1`;
              if (
                thread === undefined ||
                !claudeThreadSettingsFit(owner.record.plan, thread) ||
                pending.length > 0
              )
                claudePolicyChanged = true;
            }
            if (
              bindingConflict ||
              claudePolicyChanged ||
              new Set(rows.map((row) => row.thread_id)).size !== rows.length ||
              category === "unsupported" ||
              category === "create" ||
              workspaceChanged ||
              (category === "controlled" &&
                rows.some(
                  (native) =>
                    native.controller !== "t3" ||
                    (admission !== undefined &&
                      (admission.threadId !== native.thread_id ||
                        admission.epoch !== native.epoch)),
                ))
            ) {
              const receipt: CommandReceiptStore.CommandReceiptV2 = {
                commandId: input.commandId,
                threadId: input.threadId,
                commandType: input.commandType,
                acceptedAt: input.acceptedAt,
                resultSequence: yield* eventStore.latestSequence({ threadId: input.threadId }),
                status: "rejected",
                error: "Native session controller or policy changed before command admission.",
              };
              yield* commandReceipts.upsert(receipt);
              return {
                receipt,
                storedEvents: [],
                outcomes: [],
                committed: true as const,
                cancelledEffectIds: [],
              };
            }
            events = input.events.map((event) =>
              current !== undefined && event.threadId === input.threadId && isThreadEvent(event)
                ? {
                    ...event,
                    payload: { ...event.payload, ...Struct.pick(current, threadPolicyKeys) },
                  }
                : event,
            );
          }
          const normalized = yield* normalizeEvents(events);
          const storedEvents = yield* eventStore.append({
            commandId: input.commandId,
            events: normalized,
          });
          // A Stop that changes nothing can still queue the stop of its delegated tasks.
          const sequence =
            storedEvents.at(-1)?.sequence ??
            (input.effects.length === 0
              ? undefined
              : yield* eventStore.latestSequence({ threadId: input.threadId }));
          if (sequence === undefined) {
            return yield* Effect.die(
              new Error(`Command ${input.commandId} produced no orchestration events.`),
            );
          }
          const outcomes = yield* applyStoredEvents(storedEvents);
          yield* effectOutbox.enqueue(input.effects);
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: sequence,
            status: "accepted",
            error: null,
          };
          yield* commandReceipts.upsert(receipt);
          const cancelledEffectIds =
            input.cancelUnsettledEffects === undefined
              ? []
              : yield* effectOutbox.cancelUnsettled({
                  threadId: input.threadId,
                  ...input.cancelUnsettledEffects,
                });
          return { receipt, storedEvents, outcomes, committed: true as const, cancelledEffectIds };
        }),
        (result) =>
          Effect.gen(function* () {
            yield* effectOutbox.signalCancellations(result.cancelledEffectIds);
            if (result.committed && input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            if (result.committed) yield* publishStoredEvents(result.storedEvents, result.outcomes);
          }),
      );
      return {
        receipt: result.receipt,
        storedEvents: result.storedEvents,
        committed: result.committed,
        cancelledEffectCount: result.cancelledEffectIds.length,
      };
    });

    const commitRejectedCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const sequence = yield* eventStore.latestSequence({ threadId: input.threadId });
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: sequence,
            status: "rejected",
            error: input.error,
          };
          const inserted = yield* commandReceipts.insertIfAbsent(receipt);
          if (inserted) {
            return receipt;
          }
          const existing = yield* commandReceipts.getByCommandId(input.commandId);
          return Option.getOrElse(existing, () => receipt);
        }),
      );
    });

    const existingProjectReceipt = (commandId: CommandId) =>
      commandReceipts.getProjectByCommandId(commandId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(`Command ${commandId} was already used by a thread command.` as const),
            onSome: Effect.succeed,
          }),
        ),
      );

    const commitProjectCommandEffect = Effect.fn("orchestrationV2.EventSink.commitProjectCommand")(
      function* (input: Parameters<EventSinkV2Shape["commitProjectCommand"]>[0]) {
        const result = yield* commitThenPublish(
          Effect.gen(function* () {
            const reserved: CommandReceiptStore.ProjectCommandReceiptV2 = {
              commandId: input.commandId,
              projectId: input.projectId,
              commandType: input.commandType,
              acceptedAt: input.acceptedAt,
              resultSequence: 0,
              status: "accepted",
              error: null,
            };
            if (!(yield* commandReceipts.insertIfAbsent(reserved))) {
              return { receipt: yield* existingProjectReceipt(input.commandId), event: undefined };
            }
            const event = yield* eventStore.appendProjectEvent(input.event);
            yield* projectStore.apply(event);
            const receipt = { ...reserved, resultSequence: event.sequence };
            yield* commandReceipts.upsert(receipt);
            return { receipt, event };
          }),
          (result) =>
            result.event === undefined ? Effect.void : eventStore.publishCommitted([result.event]),
        );
        return { receipt: result.receipt, committed: result.event !== undefined };
      },
    );

    const commitRejectedProjectCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedProjectCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedProjectCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipt: CommandReceiptStore.ProjectCommandReceiptV2 = {
            commandId: input.commandId,
            projectId: input.projectId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: yield* eventStore.latestApplicationSequence,
            status: "rejected",
            error: input.error,
          };
          return (yield* commandReceipts.insertIfAbsent(receipt))
            ? receipt
            : yield* existingProjectReceipt(input.commandId);
        }),
      );
    });

    const catchUp = (input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly threadId?: ThreadId;
      readonly eventType?: OrchestrationV2DomainEvent["type"];
    }): Stream.Stream<OrchestrationV2StoredEvent, unknown> => {
      const pageSize = 256;
      const loop = (afterSequence: number): Stream.Stream<OrchestrationV2StoredEvent, unknown> =>
        Stream.unwrap(
          eventStore
            .read({
              afterSequence,
              throughSequence: input.throughSequence,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
              limit: pageSize,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.map((events) => {
                if (events.length === 0) {
                  return Stream.empty;
                }
                const current = Stream.fromIterable(events);
                const last = events.at(-1)?.sequence ?? input.throughSequence;
                return events.length < pageSize || last >= input.throughSequence
                  ? current
                  : Stream.concat(current, loop(last));
              }),
            ),
        );
      return loop(input.afterSequence);
    };

    const stream = (input?: Parameters<EventSinkV2Shape["stream"]>[0]) => {
      const afterSequence = input?.afterSequence ?? 0;
      const matches = (stored: OrchestrationV2StoredEvent) =>
        (input?.threadId === undefined || stored.event.threadId === input.threadId) &&
        (input?.eventType === undefined || stored.event.type === input.eventType);
      const replay = (throughSequence: number) =>
        catchUp({
          afterSequence,
          throughSequence,
          ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input?.eventType === undefined ? {} : { eventType: input.eventType }),
        }).pipe(Stream.filter(matches));
      return Stream.unwrap(
        Effect.gen(function* () {
          let pubsub = liveEvents;
          if (input?.eventType !== undefined) {
            const existing = liveEventsByType.get(input.eventType);
            if (existing !== undefined) {
              pubsub = existing;
            } else {
              const created = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
              pubsub = liveEventsByType.get(input.eventType) ?? created;
              liveEventsByType.set(input.eventType, pubsub);
            }
          }
          if (input?.bounded === true) {
            return replayAndBufferProjectedLiveEvents({
              subscribe: PubSub.subscribe(pubsub),
              latestSequence: eventStore.latestSequence(),
              afterSequence,
              filter: matches,
              replay,
              project: (stored) => ({ ...stored, event: projectDomainEventForWire(stored.event) }),
            });
          }
          const subscription = yield* PubSub.subscribe(pubsub);
          const highWater = yield* eventStore.latestSequence();
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((stored) => stored.sequence > Math.max(highWater, afterSequence)),
            Stream.filter(matches),
          );
          return Stream.concat(replay(highWater), live);
        }),
      );
    };

    const commitClaudeSession = Effect.fn("EventSink.commitClaudeSession")(
      function* (input: Parameters<EventSinkV2Shape["commitClaudeSession"]>[0]) {
        const result = yield* commitThenPublish(
          Effect.gen(function* () {
            const { enrollment, operation, history } = input;
            const currentRows = yield* sql<{
              revision: number;
            }>`SELECT revision FROM orchestration_v2_claude_sessions WHERE thread_id = ${enrollment.threadId}`;
            if (
              (currentRows[0]?.revision ?? null) !== input.expectedRevision ||
              enrollment.revision !== (input.expectedRevision ?? 0) + 1 ||
              (yield* eventStore.latestSequence({ threadId: enrollment.threadId })) !==
                input.expectedSequence
            )
              return { changed: false, committed: [], outcomes: [] };
            if (input.expectedThread !== undefined) {
              const current = yield* projectionStore.getThread(enrollment.threadId);
              if (!sameThreadPolicy(current, input.expectedThread))
                return { changed: false, committed: [], outcomes: [] };
            }
            if (yield* claudeBindingOwned(enrollment.plan))
              return { changed: false, committed: [], outcomes: [] };
            if (
              operation.kind === "adopt" &&
              enrollment.controller.epoch === 1 &&
              (yield* checkClaudeSessionTarget(enrollment.plan)) !== null
            )
              return { changed: false, committed: [], outcomes: [] };
            if (
              operation.kind === "release" &&
              enrollment.controller.type === "external" &&
              (yield* claudeSessionWorkActive(enrollment.threadId))
            )
              return { changed: false, committed: [], outcomes: [] };
            const operations = yield* sql<{
              payload_hash: string;
              completed: number;
            }>`SELECT payload_hash, completed FROM orchestration_v2_claude_operations WHERE operation_id = ${operation.operationId} AND thread_id = ${enrollment.threadId}`;
            if (
              operations[0]?.payload_hash !== operation.requestDigest ||
              operations[0]?.completed !== 0
            )
              return { changed: false, committed: [], outcomes: [] };
            if (history !== undefined && history.threadId !== enrollment.threadId)
              return { changed: false, committed: [], outcomes: [] };
            const store = `${enrollment.plan.configDir.effectiveRoot.device}:${enrollment.plan.configDir.effectiveRoot.inode}`;
            const transcript = `${enrollment.plan.transcript.device}:${enrollment.plan.transcript.inode}`;
            const reserved =
              yield* sql`INSERT INTO orchestration_v2_claude_sessions (thread_id, environment_id, physical_store, native_id, physical_transcript, revision, payload_json)
            VALUES (${enrollment.threadId}, ${enrollment.environmentId}, ${store}, ${enrollment.plan.nativeId}, ${transcript}, ${enrollment.revision}, ${canonicalClaudeJson(enrollment)})
            ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json
            WHERE physical_store = excluded.physical_store AND native_id = excluded.native_id AND physical_transcript = excluded.physical_transcript
            RETURNING thread_id`;
            if (reserved.length !== 1) return { changed: false, committed: [], outcomes: [] };
            if (history !== undefined)
              yield* ProjectionStore.applyClaudeHistoryProjection(history).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
            const committed = yield* eventStore.append({ events: input.events });
            const outcomes = yield* applyStoredEvents(committed);
            if (history !== undefined) {
              yield* ProjectionStore.applyClaudeHistoryProjection(history).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
              const boundarySequence = committed.at(-1)?.sequence ?? input.expectedSequence;
              yield* sql`INSERT INTO orchestration_v2_claude_history (thread_id, generation, boundary_sequence, payload_json)
              VALUES (${history.threadId}, ${history.generation}, ${boundarySequence}, ${canonicalClaudeJson(history)})
              ON CONFLICT(thread_id) DO UPDATE SET generation = excluded.generation, boundary_sequence = excluded.boundary_sequence, payload_json = excluded.payload_json`;
            }
            yield* sql`UPDATE orchestration_v2_claude_operations SET completed = ${operation.completed ? 1 : 0}, payload_json = ${canonicalClaudeJson(operation)} WHERE operation_id = ${operation.operationId} AND completed = 0`;
            return { changed: true, committed, outcomes };
          }),
          ({ committed, outcomes }) => publishStoredEvents(committed, outcomes),
        );
        return result.changed;
      },
      (effect) =>
        effect.pipe(Effect.mapError((cause) => new EventSinkWriteError({ eventCount: 0, cause }))),
    );

    return EventSinkV2.of({
      checkClaudeSessionTarget,
      commitClaudeSession,
      write: (input) =>
        writeEffect({ ...input, effects: [] }).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeWithEffects: (input) =>
        writeEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfRunCurrent: (input) =>
        writeIfRunCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadOwner: (input) =>
        writeIfProviderThreadOwnerEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadUnchanged: (input) =>
        writeIfProviderThreadUnchangedEffect(input).pipe(
          Effect.mapError(
            (cause) => new EventSinkWriteError({ eventCount: input.events.length, cause }),
          ),
        ),
      commitCommand: (input) =>
        commitCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      commitRejectedCommand: (input) =>
        commitRejectedCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: 0,
                cause,
              }),
          ),
        ),
      commitProjectCommand: (input) =>
        commitProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 1, cause }),
          ),
        ),
      commitRejectedProjectCommand: (input) =>
        commitRejectedProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 0, cause }),
          ),
        ),
      stream: (input) =>
        stream(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                cause,
              }),
          ),
        ),
      latestSequence: (input) =>
        eventStore.latestSequence(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      readByCommandId: (input) =>
        eventStore.readByCommandId(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                cause,
              }),
          ),
        ),
    } satisfies EventSinkV2Shape);
  }),
);

/** Share the worker's outbox instance: enqueue wakeups are in-memory. */
export const layerFromStores = layerBase;

export const layer: Layer.Layer<
  EventSinkV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = layerBase.pipe(
  Layer.provide(
    Layer.mergeAll(
      CommandReceiptStore.layer,
      EffectOutbox.layer,
      ProjectStore.layer,
      TurnItemPositionStore.layer,
    ),
  ),
);

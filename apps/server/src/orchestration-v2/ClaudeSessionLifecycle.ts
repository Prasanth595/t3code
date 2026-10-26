import {
  type ClaudeSessionAdoptInput,
  type ClaudeSessionRefreshInput,
  type ClaudeSessionReleaseInput,
  type ClaudeSessionStatusInput,
  type ClaudeSessionScope,
  type ClaudeSessionIdentityPlan,
  type ClaudeSessionResult,
  type ClaudeSessionBlocker,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  EventId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import type { captureClaudeSessionSnapshot } from "../claudeSessionSnapshot.ts";
import * as Runtime from "./ClaudeSessionRuntime.ts";
import * as Fence from "./ClaudeSessionFence.ts";
import * as Journal from "./ClaudeSessionJournal.ts";
import * as Ownership from "./ClaudeSessionOwnership.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { DispatchModeLimit, exceededDispatchModeLimit } from "./DispatchModeLimit.ts";

type Snapshot = Awaited<ReturnType<typeof captureClaudeSessionSnapshot>>;
export class ClaudeSessionHost extends Context.Service<
  ClaudeSessionHost,
  {
    readonly resolve: (
      input: ClaudeSessionAdoptInput,
    ) => Effect.Effect<ClaudeSessionIdentityPlan, Journal.ClaudeJournalError>;
    readonly read: (
      plan: ClaudeSessionIdentityPlan,
    ) => Effect.Effect<Snapshot, Journal.ClaudeJournalError>;
    readonly validatePlan: (
      plan: ClaudeSessionIdentityPlan,
    ) => Effect.Effect<void, Journal.ClaudeJournalError>;
    readonly validateStopped: (
      input: ClaudeSessionAdoptInput,
      plan: ClaudeSessionIdentityPlan,
    ) => Effect.Effect<void, Journal.ClaudeJournalError>;
  }
>()("t3/orchestration-v2/ClaudeSessionLifecycle/ClaudeSessionHost") {}

export class ClaudeSessionLifecycle extends Context.Service<
  ClaudeSessionLifecycle,
  {
    readonly adopt: (input: ClaudeSessionAdoptInput) => Effect.Effect<ClaudeSessionResult>;
    readonly refresh: (input: ClaudeSessionRefreshInput) => Effect.Effect<ClaudeSessionResult>;
    readonly release: (input: ClaudeSessionReleaseInput) => Effect.Effect<ClaudeSessionResult>;
    readonly status: (input: ClaudeSessionStatusInput) => Effect.Effect<ClaudeSessionResult>;
  }
>()("t3/orchestration-v2/ClaudeSessionLifecycle") {}

const driver = ProviderDriverKind.make("claudeAgent");
const scopeOf = (input: ClaudeSessionScope): ClaudeSessionScope => ({
  contractVersion: 1,
  environmentId: input.environmentId,
  projectId: input.projectId,
  threadId: input.threadId,
});
type BindingScope = Pick<ClaudeSessionScope, "environmentId" | "projectId" | "threadId">;
const sameScope = (left: BindingScope, right: BindingScope) =>
  left.environmentId === right.environmentId &&
  left.projectId === right.projectId &&
  left.threadId === right.threadId;
const adoptionBindingConflict = (
  input: ClaudeSessionAdoptInput,
  row: Journal.ClaudeEnrollment,
): ClaudeSessionBlocker["code"] | null => {
  const plan = row.plan;
  if (!sameScope(input, row) || !sameScope(input, plan)) return "scope-mismatch";
  if (input.nativeId !== plan.nativeId || input.providerInstanceId !== plan.providerInstanceId)
    return "identity-changed";
  if (
    input.selection.profile !== plan.selection.profile ||
    input.selection.model !== plan.selection.model ||
    input.selection.runtimeMode !== plan.selection.runtimeMode ||
    input.selection.effort !== plan.selection.effort
  )
    return "settings-changed";
  return null;
};
const resultOf = (
  scope: ClaudeSessionScope,
  row: Journal.ClaudeEnrollment | null,
  operationId: string | null,
  state: ClaudeSessionResult["state"],
  blockers: ReadonlyArray<ClaudeSessionBlocker> = [],
): ClaudeSessionResult => ({
  ...scopeOf(scope),
  provider: "claude",
  operationId,
  state,
  view: row?.view == null ? null : { ...row.view, controller: row.controller },
  reservation: row?.reservation ?? null,
  blockers,
});
const blockerGuidance: Record<
  ClaudeSessionBlocker["code"],
  readonly [ClaudeSessionBlocker["nextAction"], string]
> = {
  "contract-unsupported": ["unsupported", "This handoff contract version is not supported."],
  "unsupported-platform": [
    "unsupported",
    "Managed Claude handoff requires a supported Linux host.",
  ],
  "unsupported-profile": [
    "unsupported",
    "The selected Claude profile cannot provide the required handoff guarantees.",
  ],
  "scope-mismatch": ["reselect", "Select the matching environment, project and conversation."],
  "provider-unavailable": ["reselect", "Select an enabled, available Claude provider."],
  "identity-unavailable": [
    "reselect",
    "T3 cannot resolve the selected Claude executable, profile or session identity.",
  ],
  "identity-changed": [
    "reselect",
    "The selected Claude executable, profile or session identity changed. Select it again.",
  ],
  "settings-changed": [
    "reselect",
    "The selected Claude settings changed. Review and select the destination settings again.",
  ],
  "history-unavailable": [
    "resolve-in-t3",
    "T3 could not read the saved conversation. Resolve its availability before retrying.",
  ],
  "history-incomplete": [
    "resolve-in-t3",
    "The saved conversation is incomplete. Resolve its history before handoff.",
  ],
  "history-changed": [
    "retry-same-operation",
    "The saved history changed during the read. Retry this operation after writes stop.",
  ],
  "native-binding-owned": [
    "resolve-in-t3",
    "Another T3 binding owns this native conversation. Release that binding first.",
  ],
  "target-not-empty": ["reselect", "Select an empty T3 conversation for adoption."],
  "source-not-idle": ["wait", "Stop the source conversation and wait for its process to exit."],
  "terminal-changed": [
    "reselect",
    "The selected terminal changed. Select the destination terminal again.",
  ],
  "previous-return-unresolved": [
    "resolve-in-t3",
    "Reconcile the previous return reservation before adopting this conversation again.",
  ],
  "stale-epoch": [
    "reselect",
    "Conversation ownership changed. Refresh its status and select the current owner.",
  ],
  "operation-conflict": [
    "reselect",
    "This operation identifier belongs to a different request. Refresh status before starting a new operation.",
  ],
  "managed-work-active": [
    "resolve-in-t3",
    "Finish or cancel active turns, approvals, background work and schedules in T3 before release.",
  ],
  "managed-delivery-unknown": [
    "resolve-in-t3",
    "T3 cannot confirm a previous native write. Reconcile its delivery before sending it again.",
  ],
  "process-exit-unproved": [
    "wait",
    "Wait for the exact conversation child and its runtime finalizers to exit, then retry this operation.",
  ],
  "runtime-state-unknown": [
    "resolve-in-t3",
    "T3 cannot prove the conversation is idle. Resolve its runtime and background-work state before release.",
  ],
  "projection-conflict": [
    "retry-same-operation",
    "The conversation changed while the handoff was committing. Retry this operation.",
  ],
};
const blocker = (code: ClaudeSessionBlocker["code"]): ClaudeSessionBlocker => {
  const [nextAction, detail] = blockerGuidance[code];
  return { code, detail, nextAction };
};
const fail = (code: ClaudeSessionBlocker["code"]) => new Journal.ClaudeJournalError({ code });
const MessagePayload = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
});
const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const UnsupportedBlock = Schema.Struct({ type: Schema.String });
const textOf = (payload: unknown) => {
  const message = Schema.decodeUnknownOption(MessagePayload)(payload);
  if (Option.isNone(message)) return "[Unsupported native message]";
  if (typeof message.value.content === "string") return message.value.content;
  return message.value.content
    .map((block) => {
      const text = Schema.decodeUnknownOption(TextBlock)(block);
      if (Option.isSome(text)) return text.value.text;
      const typed = Schema.decodeUnknownOption(UnsupportedBlock)(block);
      return `[Native ${Option.isSome(typed) ? typed.value.type : "unsupported content"}]`;
    })
    .join("\n");
};

const make = Effect.gen(function* () {
  const journal = yield* Journal.ClaudeSessionJournal;
  const ownership = yield* Ownership.ClaudeSessionOwnership;
  const host = yield* ClaudeSessionHost;
  const runtime = yield* Runtime.ClaudeSessionLifecycleRuntime;
  const fence = yield* Fence.ClaudeSessionFence;
  const sink = yield* EventSink.EventSinkV2;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const allocator = yield* IdAllocator.IdAllocatorV2;
  const sql = yield* SqlClient.SqlClient;
  const locks = yield* KeyedLock.make<ClaudeSessionScope["threadId"]>();
  const getProjection = Effect.fn("ClaudeSessionLifecycle.projection")(function* (
    threadId: ClaudeSessionScope["threadId"],
  ) {
    return yield* projections.getThreadProjection(threadId).pipe(
      Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
      Effect.mapError(
        (cause) => new Journal.ClaudeJournalError({ code: "projection-conflict", cause }),
      ),
    );
  });
  const sequence = Effect.fn("ClaudeSessionLifecycle.sequence")(
    (threadId: ClaudeSessionScope["threadId"]) =>
      events
        .latestSequence({ threadId })
        .pipe(
          Effect.mapError(
            (cause) => new Journal.ClaudeJournalError({ code: "projection-conflict", cause }),
          ),
        ),
  );
  const commit = Effect.fn("ClaudeSessionLifecycle.commit")(function* (
    input: Parameters<EventSink.EventSinkV2["Service"]["commitClaudeSession"]>[0],
  ) {
    if (
      !(yield* sink
        .commitClaudeSession(input)
        .pipe(
          Effect.mapError(
            (cause) => new Journal.ClaudeJournalError({ code: "projection-conflict", cause }),
          ),
        ))
    )
      return yield* fail("projection-conflict");
  });
  const checkWork = Effect.fn("ClaudeSessionLifecycle.checkWork")(
    function* (row: Journal.ClaudeEnrollment) {
      const pending =
        yield* sql`SELECT write_id FROM orchestration_v2_claude_writes WHERE thread_id = ${row.threadId} AND state <> 'settled'`;
      if (pending.length > 0) return yield* fail("managed-delivery-unknown");
      yield* runtime.assertQuiet(row.threadId);
      const projection = yield* getProjection(row.threadId);
      if (
        projection !== null &&
        (projection.runs.some(
          (run) =>
            !["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
              run.status,
            ),
        ) ||
          projection.runtimeRequests.some((request) => request.status === "pending") ||
          projection.subagents.some((agent) => agent.status === "running"))
      )
        return yield* fail("managed-work-active");
      const outbox =
        yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${row.threadId} AND status IN ('pending', 'running')`;
      const schedules =
        yield* sql`SELECT task_id FROM scheduled_tasks WHERE thread_id = ${row.threadId} AND enabled = 1`;
      if (outbox.length > 0 || schedules.length > 0) return yield* fail("managed-work-active");
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((cause) =>
          Schema.is(Journal.ClaudeJournalError)(cause)
            ? cause
            : new Journal.ClaudeJournalError({ code: "runtime-state-unknown", cause }),
        ),
      ),
  );
  const project = Effect.fn("ClaudeSessionLifecycle.project")(function* (
    row: Journal.ClaudeEnrollment,
    snapshot: Snapshot,
    operation: Journal.ClaudeOperation,
    projection: OrchestrationV2ThreadProjection | null,
    expectedSequence: number,
    reservation: ClaudeSessionResult["reservation"] = null,
  ) {
    const old = yield* journal.history(row.threadId);
    const prompts = yield* fence.promptMappings(row.threadId);
    const generation = (old?.generation ?? 0) + 1;
    const now = yield* DateTime.now;
    const selection = {
      instanceId: row.plan.providerInstanceId,
      model: row.plan.selection.model,
      ...(row.plan.selection.effort === undefined
        ? {}
        : { options: [{ id: "effort", value: row.plan.selection.effort }] }),
    };
    const thread: OrchestrationV2AppThread = projection?.thread ?? {
      id: row.threadId,
      projectId: row.projectId,
      title: snapshot.info.summary.slice(0, 200) || "Claude conversation",
      createdBy: "user",
      creationSource: "server",
      providerInstanceId: row.plan.providerInstanceId,
      modelSelection: selection,
      runtimeMode: row.plan.selection.runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: row.threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const provider: OrchestrationV2ProviderThread = {
      ...(projection?.providerThreads[0] ?? {
        id: allocator.derive.providerThread({
          driver,
          providerInstanceId: row.plan.providerInstanceId,
          nativeThreadId: row.plan.nativeId,
        }),
        driver,
        providerInstanceId: row.plan.providerInstanceId,
        providerSessionId: null,
        appThreadId: row.threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: row.plan.nativeId, strength: "strong" as const },
        nativeConversationHeadRef: null,
        status: "not_loaded" as const,
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        contextUsage: null,
        createdAt: now,
        updatedAt: now,
      }),
      nativeMetadata: {
        ...projection?.providerThreads[0]?.nativeMetadata,
        historyAuthority: "native",
        historyGeneration: generation,
        controllerEpoch: row.controller.epoch,
        modelSelection: selection,
      },
      updatedAt: now,
    };
    const projected: OrchestrationV2DomainEvent[] = [];
    const eventId = (kind: string, identity: string) =>
      EventId.make(
        `claude:${row.threadId}:${generation}:${kind}:${identity}:${operation.operationId}`,
      );
    if (projection === null)
      projected.push({
        type: "thread.created",
        id: eventId("thread", row.threadId),
        threadId: row.threadId,
        occurredAt: now,
        payload: thread,
      });
    const items: Journal.ClaudeHistory["items"][number][] = [];
    const liveNativeItems =
      projection?.turnItems.filter(
        (item) =>
          item.providerThreadId === provider.id &&
          item.nativeItemRef?.driver === driver &&
          item.nativeItemRef.strength === "strong",
      ) ?? [];
    const nativeIds = new Set([
      ...(old?.items.map((item) => item.turnItemId) ?? []),
      ...prompts.map((prompt) => prompt.turnItemId),
      ...liveNativeItems.map((item) => item.id),
    ]);
    const appOrdinals = new Set(
      projection?.turnItems.filter((item) => !nativeIds.has(item.id)).map((item) => item.ordinal) ??
        [],
    );
    let ordinal = 0;
    for (const message of snapshot.messages) {
      const prompt = prompts.find((item) => item.uuid === message.uuid);
      const mapped = old?.items.find((item) => item.uuid === message.uuid);
      const live =
        liveNativeItems.find((item) => item.nativeItemRef?.nativeId === message.uuid) ??
        projection?.turnItems.find((item) => item.id === prompt?.turnItemId);
      const turnItemId =
        mapped?.turnItemId ??
        prompt?.turnItemId ??
        live?.id ??
        allocator.derive.turnItemFromProviderItem({ driver, nativeItemId: message.uuid });
      const messageId =
        mapped?.messageId ??
        prompt?.messageId ??
        (live?.type === "user_message" || live?.type === "assistant_message"
          ? live.messageId
          : allocator.derive.messageFromProviderItem({ driver, nativeItemId: message.uuid }));
      const previous = projection?.messages.find((item) => item.id === messageId);
      const text = textOf(message.message);
      do {
        ordinal++;
      } while (appOrdinals.has(ordinal));
      const base = {
        id: turnItemId,
        threadId: row.threadId,
        runId: live?.runId ?? null,
        nodeId: live?.nodeId ?? null,
        providerThreadId: provider.id,
        providerTurnId: live?.providerTurnId ?? null,
        nativeItemRef: { driver, nativeId: message.uuid, strength: "strong" as const },
        parentItemId: null,
        ordinal,
        status: "completed" as const,
        title: null,
        startedAt: live?.startedAt ?? now,
        completedAt: now,
        updatedAt: now,
      };
      const item: OrchestrationV2TurnItem =
        message.type === "user"
          ? {
              ...base,
              type: "user_message",
              inputIntent: "turn_start",
              messageId,
              text,
              attachments: previous?.attachments ?? [],
              createdBy: previous?.createdBy ?? "user",
              creationSource: previous?.creationSource ?? "provider",
            }
          : { ...base, type: "assistant_message", messageId, text, streaming: false };
      projected.push({
        type: "message.updated",
        id: eventId("message", message.uuid),
        threadId: row.threadId,
        occurredAt: now,
        payload: {
          id: messageId,
          threadId: row.threadId,
          runId: previous?.runId ?? null,
          nodeId: previous?.nodeId ?? null,
          role: message.type === "user" ? "user" : "assistant",
          text,
          attachments: previous?.attachments ?? [],
          streaming: false,
          createdBy: previous?.createdBy ?? (message.type === "user" ? "user" : "agent"),
          creationSource: previous?.creationSource ?? "provider",
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        },
      });
      projected.push({
        type: "turn-item.updated",
        id: eventId("item", message.uuid),
        threadId: row.threadId,
        occurredAt: now,
        payload: item,
      });
      items.push({ uuid: message.uuid, messageId, turnItemId, ordinal, payload: message });
    }
    const retainedMessages = new Set(items.map((item) => item.messageId));
    const retainedItems = new Set(items.map((item) => item.turnItemId));
    const history: Journal.ClaudeHistory = {
      threadId: row.threadId,
      generation,
      digest: snapshot.digest,
      items,
      removedMessageIds: [
        ...new Set([
          ...(old?.removedMessageIds ?? []),
          ...(old?.items.flatMap((item) => (item.messageId === null ? [] : [item.messageId])) ??
            []),
          ...prompts.map((prompt) => prompt.messageId),
          ...liveNativeItems.flatMap((item) =>
            item.type === "user_message" || item.type === "assistant_message"
              ? [item.messageId]
              : [],
          ),
        ]),
      ].filter((id) => !retainedMessages.has(id)),
      removedTurnItemIds: [...new Set([...(old?.removedTurnItemIds ?? []), ...nativeIds])].filter(
        (id) => !retainedItems.has(id),
      ),
    };
    projected.push({
      type: "provider-thread.updated",
      id: eventId("provider", provider.id),
      threadId: row.threadId,
      occurredAt: now,
      payload: provider,
    });
    const view = {
      plan: row.plan,
      controller: row.controller,
      history: {
        authority: "native" as const,
        scope: "root-active-chain" as const,
        generation,
        digest: snapshot.digest,
      },
      runtime: yield* runtime.view(
        row.threadId,
        row.controller.type === "t3" ? row.controller.epoch : undefined,
      ),
      settingsBasis: "selected-destination" as const,
      writerScope: "participating-clients" as const,
      unmanagedWriterExclusion: "not-proved" as const,
    };
    const next = { ...row, view, reservation, blockers: [], revision: row.revision + 1 };
    const result = resultOf(row, next, operation.operationId, "ready");
    yield* host.validatePlan(row.plan);
    yield* commit({
      expectedRevision: row.revision,
      expectedSequence,
      ...(projection === null ? {} : { expectedThread: projection.thread }),
      enrollment: next,
      history,
      operation: { ...operation, completed: true, result },
      events: projected,
    });
    return result;
  });
  const run = <I extends Journal.ClaudeOperation["request"]>(
    kind: Journal.ClaudeOperation["kind"],
    body: (
      input: I,
      operation: Journal.ClaudeOperation,
    ) => Effect.Effect<ClaudeSessionResult, Journal.ClaudeJournalError>,
  ) =>
    Effect.fn(`ClaudeSessionLifecycle.${kind}`)(function* (input: I) {
      const operation = yield* journal.begin(kind, input).pipe(Effect.result);
      if (operation._tag === "Failure")
        return resultOf(input, null, input.operationId, "blocked", [
          blocker(operation.failure.code),
        ]);
      if (operation.success.completed && operation.success.result !== null)
        return operation.success.result;
      return yield* locks.withLock(
        input.threadId,
        Effect.gen(function* () {
          const current = yield* journal.operation(input.operationId);
          if (current?.completed && current.result !== null) return current.result;
          return yield* body(input, operation.success).pipe(
            Effect.catch((error) =>
              journal.get(input.threadId).pipe(
                Effect.flatMap((row) =>
                  Effect.gen(function* () {
                    const current =
                      row?.view == null
                        ? row
                        : {
                            ...row,
                            view: { ...row.view, runtime: yield* runtime.view(row.threadId) },
                          };
                    return yield* journal.progress(
                      operation.success,
                      resultOf(input, current, input.operationId, "blocked", [blocker(error.code)]),
                    );
                  }),
                ),
              ),
            ),
          );
        }),
      );
    });
  const adopt = run<ClaudeSessionAdoptInput>(
    "adopt",
    Effect.fn("ClaudeSessionLifecycle.adoptOperation")(function* (input, operation) {
      let row = yield* journal.get(input.threadId);
      if (row !== null) {
        const conflict = adoptionBindingConflict(input, row);
        if (conflict !== null) return yield* fail(conflict);
      }
      const ceiling = yield* DispatchModeLimit;
      if (
        ceiling !== undefined &&
        exceededDispatchModeLimit(ceiling, {
          runtimeMode: input.selection.runtimeMode,
          interactionMode: "default",
        }) !== undefined
      )
        return yield* fail("unsupported-profile");
      if (row === null) {
        if (input.expectedEpoch !== null || input.previousReturn !== undefined)
          return yield* fail("stale-epoch");
        const plan = yield* host.resolve(input);
        yield* host.validateStopped(input, plan);
        const expectedSequence = yield* sequence(input.threadId);
        const targetConflict = yield* sink
          .checkClaudeSessionTarget(plan)
          .pipe(
            Effect.mapError(
              (cause) => new Journal.ClaudeJournalError({ code: "projection-conflict", cause }),
            ),
          );
        if (targetConflict !== null) return yield* fail(targetConflict);
        const authority = yield* ownership.claim(plan, input.operationId);
        row = {
          ...scopeOf(input),
          ownershipGeneration: authority.bindingGeneration,
          operationId: input.operationId,
          plan,
          controller: { type: "adopting", epoch: 1 },
          sourceTerminal: input.sourceStopped.terminal,
          revision: 1,
          managedWriteRevision: 0,
          view: null,
          reservation: null,
          blockers: [],
        };
        yield* commit({
          expectedRevision: null,
          expectedSequence,
          enrollment: row,
          operation: { ...operation, result: resultOf(input, row, input.operationId, "pending") },
          events: [],
        });
      } else if (row.controller.type === "external") {
        if (input.expectedEpoch !== row.controller.epoch) return yield* fail("stale-epoch");
        const previous = input.previousReturn;
        const reservation = row.reservation;
        if (
          previous === undefined ||
          reservation === null ||
          previous.reservationId !== reservation.reservationId ||
          previous.actionId !== reservation.actionId ||
          previous.planDigest !== row.plan.planDigest ||
          previous.terminalDigest !== Journal.claudePayloadHash(reservation.destination) ||
          Journal.claudePayloadHash(input.sourceStopped.terminal) !==
            Journal.claudePayloadHash(row.sourceTerminal) ||
          Journal.claudePayloadHash(input.sourceStopped.knownPreviousProcess) !==
            Journal.claudePayloadHash(previous.process)
        )
          return yield* fail("previous-return-unresolved");
        yield* host.validateStopped(input, row.plan);
        const next = {
          ...row,
          operationId: input.operationId,
          controller: { type: "adopting" as const, epoch: row.controller.epoch + 1 },
          revision: row.revision + 1,
          reservation: null,
        };
        yield* commit({
          expectedRevision: row.revision,
          expectedSequence: yield* sequence(row.threadId),
          enrollment: next,
          operation,
          events: [],
        });
        row = next;
      } else if (row.controller.type !== "adopting" || row.operationId !== input.operationId)
        return yield* fail("native-binding-owned");
      yield* ownership.claim(row.plan, input.operationId, row.ownershipGeneration);
      yield* host.validatePlan(row.plan);
      const capturedSequence = yield* sequence(row.threadId);
      const projection = yield* getProjection(row.threadId);
      const snapshot = yield* host.read(row.plan);
      yield* host.validateStopped(input, row.plan);
      return yield* project(
        { ...row, controller: { type: "t3", epoch: row.controller.epoch } },
        snapshot,
        operation,
        projection,
        capturedSequence,
      );
    }),
  );
  const refresh = run<ClaudeSessionRefreshInput>(
    "refresh",
    Effect.fn("ClaudeSessionLifecycle.refreshOperation")(function* (input, operation) {
      const row = yield* journal.get(input.threadId);
      if (row === null) return resultOf(input, null, input.operationId, "not-found");
      if (!sameScope(row, input)) return yield* fail("scope-mismatch");
      if (input.expectedEpoch !== row.controller.epoch || row.controller.type !== "t3")
        return yield* fail("stale-epoch");
      yield* checkWork(row);
      yield* ownership.claim(row.plan, input.operationId, row.ownershipGeneration);
      yield* host.validatePlan(row.plan);
      const capturedSequence = yield* sequence(row.threadId);
      const projection = yield* getProjection(row.threadId);
      const snapshot = yield* host.read(row.plan);
      return yield* project(row, snapshot, operation, projection, capturedSequence);
    }),
  );
  const release = run<ClaudeSessionReleaseInput>(
    "release",
    Effect.fn("ClaudeSessionLifecycle.releaseOperation")(function* (input, operation) {
      let row = yield* journal.get(input.threadId);
      if (row === null) return resultOf(input, null, input.operationId, "not-found");
      if (!sameScope(row, input)) return yield* fail("scope-mismatch");
      if (input.planDigest !== row.plan.planDigest) return yield* fail("identity-changed");
      if (row.controller.type === "t3" && input.expectedEpoch === row.controller.epoch) {
        const next = {
          ...row,
          operationId: input.operationId,
          controller: { type: "releasing" as const, epoch: row.controller.epoch + 1 },
          revision: row.revision + 1,
        };
        yield* commit({
          expectedRevision: row.revision,
          expectedSequence: yield* sequence(row.threadId),
          enrollment: next,
          operation,
          events: [],
        });
        row = next;
      } else if (
        row.controller.type !== "releasing" ||
        row.operationId !== input.operationId ||
        input.expectedEpoch + 1 !== row.controller.epoch
      )
        return yield* fail("stale-epoch");
      yield* checkWork(row);
      const processDisposition = yield* runtime.release(row.threadId);
      yield* checkWork(row);
      const current = yield* journal.get(row.threadId);
      if (
        current === null ||
        current.controller.type !== "releasing" ||
        current.controller.epoch !== row.controller.epoch
      )
        return yield* fail("stale-epoch");
      row = current;
      yield* ownership.claim(row.plan, input.operationId, row.ownershipGeneration);
      yield* host.validatePlan(row.plan);
      const capturedSequence = yield* sequence(row.threadId);
      const projection = yield* getProjection(row.threadId);
      const snapshot = yield* host.read(row.plan);
      const reservation = {
        reservationId: yield* randomUuidV4,
        operationId: input.operationId,
        actionId: yield* randomUuidV4,
        epoch: row.controller.epoch,
        planDigest: row.plan.planDigest,
        finalHistoryDigest: snapshot.digest,
        destination: input.destination,
        processDisposition,
      };
      return yield* project(
        { ...row, controller: { type: "external", epoch: row.controller.epoch } },
        snapshot,
        operation,
        projection,
        capturedSequence,
        reservation,
      );
    }),
  );
  const status = Effect.fn("ClaudeSessionLifecycle.status")(function* (
    input: ClaudeSessionStatusInput,
  ) {
    if (input.operationId !== undefined) {
      const operation = yield* journal.operation(input.operationId);
      if (operation === null || !sameScope(operation.request, input))
        return resultOf(input, null, input.operationId, "not-found");
      return operation.result ?? resultOf(input, null, input.operationId, "pending");
    }
    const row = yield* journal.get(input.threadId);
    if (row === null || !sameScope(row, input)) return resultOf(input, null, null, "not-found");
    const drift = yield* host.validatePlan(row.plan).pipe(Effect.result);
    const current =
      row.view === null
        ? row
        : {
            ...row,
            view: {
              ...row.view,
              runtime: yield* runtime.view(
                row.threadId,
                row.controller.type === "t3" ? row.controller.epoch : undefined,
              ),
            },
          };
    return resultOf(
      input,
      current,
      null,
      row.controller.type === "t3" || row.controller.type === "external" ? "ready" : "pending",
      drift._tag === "Failure" ? [blocker(drift.failure.code)] : row.blockers,
    );
  });
  const recover =
    (input: ClaudeSessionStatusInput) =>
    (effect: Effect.Effect<ClaudeSessionResult, Journal.ClaudeJournalError>) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.succeed(
            resultOf(input, null, input.operationId ?? null, "blocked", [blocker(error.code)]),
          ),
        ),
      );
  return ClaudeSessionLifecycle.of({
    adopt: (input) => adopt(input).pipe(recover(input)),
    refresh: (input) => refresh(input).pipe(recover(input)),
    release: (input) => release(input).pipe(recover(input)),
    status: (input) => status(input).pipe(recover(input)),
  });
});

export const layer = Layer.effect(ClaudeSessionLifecycle, make);

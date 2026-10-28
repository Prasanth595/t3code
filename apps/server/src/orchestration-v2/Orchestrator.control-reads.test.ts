import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  type OrchestrationV2DomainEvent,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import {
  orchestrationCommandDuration,
  orchestrationCommandsTotal,
} from "../observability/Metrics.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as TemporaryThreadStorage from "./TemporaryThreadStorage.ts";
import * as TemporaryThreadService from "./TemporaryThreadService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const layerTemporaryTest = Orchestrator.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      ProviderContinuationRequests.layer,
      CommandPolicy.layer,
      RuntimePolicy.layer,
      ThreadForkService.layer,
      ServerSettings.layerTest(),
      CheckpointService.layer.pipe(
        Layer.provide(Layer.mock(CheckpointStore.CheckpointStore)({})),
        Layer.provide(NodeServices.layer),
      ),
      Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
      Layer.mock(ProviderSwitchService.ProviderSwitchServiceV2)({}),
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
    ),
  ),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(TemporaryThreadService.layerState),
  Layer.provideMerge(TemporaryThreadStorage.layer.pipe(Layer.provide(layerDatabase))),
);

const createTemporaryParent = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make("thread:temporary-parent");
  yield* orchestrator.dispatch({
    type: "thread.create",
    temporary: true,
    threadId,
    commandId: CommandId.make("temporary-parent-create"),
    projectId: ProjectId.make("project:temporary-parent"),
    title: "Temporary parent",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

it.effect(
  "records approval feedback and targets only its runtime request without dispatching a parent turn",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:approval-feedback");
      const sessionId = ProviderSessionId.make("session:approval-feedback");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-approval-feedback"),
        threadId,
        projectId: ProjectId.make("project:approval-feedback"),
        title: "Parent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* projections.apply({
        id: EventId.make("session:approval-feedback"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const name of ["child", "other"]) {
        yield* projections.apply({
          id: EventId.make(`request:${name}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(name),
            nodeId: NodeId.make(`node:${name}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: sessionId,
              supportsFeedback: name === "child",
            },
            createdAt: now,
            resolvedAt: null,
          },
        });
      }
      const commandId = CommandId.make("respond:approval-feedback");
      const feedback = "Run it in a safer manner.";
      for (const [index, invalid] of [
        { requestId: RuntimeRequestId.make("other"), decision: "decline" as const, feedback },
        { requestId: RuntimeRequestId.make("child"), decision: "accept" as const, feedback },
        { requestId: RuntimeRequestId.make("child"), decision: "decline" as const, feedback: "  " },
      ].entries()) {
        const rejectedId = CommandId.make(`invalid-feedback:${index}`);
        const rejected = yield* orchestrator
          .dispatch({
            type: "runtime-request.respond",
            commandId: rejectedId,
            threadId,
            ...invalid,
          })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(rejected));
        assert.deepEqual(yield* outbox.listByCommandId(rejectedId), []);
      }
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId,
        threadId,
        requestId: RuntimeRequestId.make("child"),
        decision: "decline",
        feedback,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(
        projection.runtimeRequests.find((request) => request.id === "child")?.feedback,
        feedback,
      );
      assert.equal(
        projection.runtimeRequests.find((request) => request.id === "other")?.status,
        "pending",
      );
      assert.equal(projection.messages.at(-1)?.text, feedback);
      const feedbackMessageId = MessageId.make("approval-feedback:child");
      assert.ok(
        projection.visibleTurnItems.some(
          ({ item }) =>
            item.type === "user_message" &&
            item.messageId === feedbackMessageId &&
            item.text === feedback,
        ),
      );
      const history = yield* projections.getTimelinePage(threadId, { limit: 20, view: "messages" });
      assert.ok(
        history.items.some(
          ({ item }) =>
            item.type === "user_message" &&
            item.messageId === feedbackMessageId &&
            item.text === feedback,
        ),
      );
      assert.equal(projection.runs.length, 0);
      assert.deepEqual(
        (yield* outbox.listByCommandId(commandId)).map((effect) => effect.request),
        [
          {
            type: "runtime-request.respond",
            providerSessionId: sessionId,
            requestId: RuntimeRequestId.make("child"),
            decision: "decline",
            feedback,
          },
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("marks a never-visited thread's first completion unread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:completion-watermark");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-completion-watermark"),
      threadId,
      projectId: ProjectId.make("project:completion-watermark"),
      title: "Background task",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    assert.isNull((yield* projections.getThreadShell(threadId))?.lastVisitedAt);
    const dispatch = (id: string) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text: "Run in the background",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "mcp",
      });
    yield* TestClock.adjust("1 second");
    const dispatchedAt = yield* DateTime.now;
    yield* dispatch("first-completion-watermark");
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("interrupt-completion-watermark"),
      threadId,
      runId: (yield* projections.getThreadProjection(threadId)).runs[0]!.id,
    });
    // The run ends in the dispatch's millisecond and must still be unread.
    const ended = yield* projections.getThreadShell(threadId);
    assert.ok(ended?.lastVisitedAt && ended.latestRunCompletedAt);
    assert.equal(
      DateTime.toEpochMillis(ended.lastVisitedAt),
      DateTime.toEpochMillis(dispatchedAt) - 1,
    );
    assert.isAbove(
      DateTime.toEpochMillis(ended.latestRunCompletedAt),
      DateTime.toEpochMillis(ended.lastVisitedAt),
    );

    yield* TestClock.adjust("1 second");
    yield* dispatch("second-completion-watermark");
    assert.deepEqual(
      (yield* projections.getThreadShell(threadId))?.lastVisitedAt,
      ended.lastVisitedAt,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "dispatches metadata, queue resume and request controls without hydrating unrelated history",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threadId = ThreadId.make("thread:control-dispatch");
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-control"),
        threadId,
        projectId: ProjectId.make("project:control-dispatch"),
        title: "Before",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const enabled of [false, true]) {
        yield* orchestrator.dispatch({
          type: "thread.auto-settle.set",
          commandId: CommandId.make(`auto-settle-${enabled}`),
          threadId,
          enabled,
        });
        const updated = yield* projections.getThreadProjection(threadId);
        assert.equal(updated.thread.autoSettleDisabledAt == null, enabled);
        const shell = yield* projections.getThreadShell(threadId);
        assert.ok(shell);
        assert.equal(shell.autoSettleDisabledAt == null, enabled);
      }
      yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('obsolete', ${threadId}, NULL, NULL, 'assistant', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      assert.equal((yield* Effect.exit(projections.getThreadProjection(threadId)))._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-empty-queue"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-control"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("mode-control"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("model-control"),
        threadId,
        modelSelection: { ...modelSelection, model: "gpt-6" },
      });
      const sessionId = ProviderSessionId.make("session:control-dispatch");
      yield* projections.apply({
        id: EventId.make("attach-control"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: sessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: "gpt-6",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      for (const mode of ["live", "message"] as const) {
        const requestId = RuntimeRequestId.make(`request:${mode}`);
        yield* projections.apply({
          id: EventId.make(`request:${mode}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: NodeId.make(`node:${mode}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability:
              mode === "live"
                ? { type: "live", providerSessionId: sessionId }
                : { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const nodeId = NodeId.make(`node:${mode}`);
        yield* projections.apply({
          id: EventId.make(`node:${mode}`),
          type: "node.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`item:${mode}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${mode}`),
            threadId,
            runId: null,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: mode === "live" ? 1 : 2,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [],
          },
        });
        const answers = { text: "Blue", list: ["Red"], codex: { answers: ["Green"] } };
        const normalizedAnswers = { ...answers, codex: ["Green"] };
        if (mode === "live") {
          const pending = yield* projections.getRuntimeResponseContext(threadId, requestId);
          const sequence = yield* orchestrator.getThreadEventSequence(threadId);
          for (const [index, value] of [
            null,
            42,
            { choice: "Blue" },
            ["Blue", 42],
            { answers: [42] },
          ].entries()) {
            const commandId = CommandId.make(`invalid-answer:${index}`);
            const result = yield* orchestrator
              .dispatch({
                type: "runtime-request.respond",
                commandId,
                threadId,
                requestId,
                answers: { ...answers, invalid: value },
              })
              .pipe(Effect.result);
            assert.isTrue(Result.isFailure(result));
            assert.deepEqual(
              yield* projections.getRuntimeResponseContext(threadId, requestId),
              pending,
            );
            assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
            assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
          }
        }
        yield* orchestrator.dispatch(
          mode === "live"
            ? {
                type: "runtime-request.respond",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
                answers,
              }
            : {
                type: "thread.user-input.dismiss",
                commandId: CommandId.make(`respond:${mode}`),
                threadId,
                requestId,
              },
        );
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, requestId))?.status,
          "resolved",
        );
        const response = yield* projections.getRuntimeResponseContext(threadId, requestId);
        assert.equal(response.node?.status, mode === "live" ? "completed" : "cancelled");
        assert.equal(response.item?.status, mode === "live" ? "completed" : "cancelled");
        if (mode === "live") {
          assert.deepEqual(response.request?.answers, normalizedAnswers);
          assert.equal(response.item?.type, "user_input_request");
          if (response.item?.type === "user_input_request") {
            assert.deepEqual(response.item.questionAnswer?.answers, normalizedAnswers);
          }
          const effects = yield* outbox.listByCommandId(CommandId.make(`respond:${mode}`));
          assert.deepEqual(
            effects.map((effect) => effect.request),
            [
              {
                type: "runtime-request.respond",
                providerSessionId: sessionId,
                requestId,
                answers: normalizedAnswers,
              },
            ],
          );
        }
      }
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("workspace-control"),
        threadId,
        worktreePath: "/new-repo",
      });
      const thread = yield* projections.getThread(threadId);
      assert.equal(thread.title, "After");
      assert.equal(thread.modelSelection.model, "gpt-6");
      assert.equal(thread.runtimeMode, "approval-required");
      assert.deepEqual(
        (yield* projections.getThreadProviderContext(threadId)).providerSessions,
        [],
      );
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          type, status, ordinal, updated_at, payload_json)
        VALUES ('obsolete-output', ${threadId}, NULL, NULL, NULL, NULL,
          'command_execution', 'completed', 900, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, run_id, node_id, kind, status, payload_json)
        VALUES ('obsolete-plan', ${threadId}, NULL, 'old-node', 'proposed', 'completed', '{"obsolete":true}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_handoffs
        (context_handoff_id, thread_id, target_run_id, to_provider_thread_id, strategy, status, updated_at, payload_json)
        VALUES ('obsolete-handoff', ${threadId}, 'old-run', 'old-provider-thread', 'full_thread_summary', 'ready', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("dispatch-with-old-history"),
        threadId,
        messageId: MessageId.make("fresh-input"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const fresh = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["user_message"],
      });
      assert.isAbove(fresh.turnItems.at(-1)!.ordinal, 900);
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-with-old-history"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-with-old-history"),
        threadId,
      });
      assert.isNotNull((yield* projections.getThread(threadId)).deletedAt);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("implements a proposed plan that the command projection leaves out", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:implement-plan");
    const planId = PlanId.make("plan:implement-plan");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-implement-plan"),
      threadId,
      projectId: ProjectId.make("project:implement-plan"),
      title: "Plan",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("plan:implement-plan"),
      type: "plan.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: planId,
        threadId,
        runId: null,
        nodeId: NodeId.make("node:implement-plan"),
        kind: "proposed_plan",
        status: "active",
        markdown: "# Plan\n\n1. Do the thing.",
      },
    });

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("implement-plan"),
      threadId,
      messageId: MessageId.make("implement-plan-input"),
      text: "Implement the plan.",
      attachments: [],
      sourcePlanRef: { threadId, planId },
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });

    assert.equal((yield* projections.getPlan(threadId, planId))?.status, "completed");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("settles only the stopped run's background work, once", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:settle-binding");
    const providerThreadId = ProviderThreadId.make("provider-thread:settle-binding");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-binding"),
      threadId,
      projectId: ProjectId.make("project:settle-binding"),
      title: "Settle binding",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make("settle-binding:provider-thread"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
    const commandItem = (ordinal: number) => TurnItemId.make(`turn-item:settle-binding:${ordinal}`);
    for (const ordinal of [1, 2]) {
      const runId = RunId.make(`run:settle-binding:${ordinal}`);
      const attemptId = RunAttemptId.make(`attempt:settle-binding:${ordinal}`);
      const nodeId = NodeId.make(`node:settle-binding:${ordinal}`);
      const providerTurnId = ProviderTurnId.make(`provider-turn:settle-binding:${ordinal}`);
      yield* projections.apply({
        id: EventId.make(`settle-binding:run:${ordinal}`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`message:settle-binding:${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:attempt:${ordinal}`),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:turn:${ordinal}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projections.apply({
        id: EventId.make(`settle-binding:item:${ordinal}`),
        type: "turn-item.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: commandItem(ordinal),
          threadId,
          runId,
          nodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 10,
          status: "running",
          title: `Background command ${ordinal}`,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: `sleep ${ordinal}`,
        },
      });
    }
    const itemStatuses = Effect.map(projections.getThreadProjection(threadId), (projection) =>
      projection.turnItems
        .flatMap((item) => (item.type === "command_execution" ? [`${item.id}:${item.status}`] : []))
        .toSorted(),
    );
    const settle = {
      type: "thread.background-work.settle",
      commandId: CommandId.make("stop-run-1:background-work-settled"),
      threadId,
      providerThreadId,
      providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
    } as const;
    yield* orchestrator.dispatch(settle);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
    ]);

    const emptySettle = {
      ...settle,
      commandId: CommandId.make("stop-run-1-again:background-work-settled"),
    };
    const first = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(first.storedEvents, 0);
    yield* projections.apply({
      id: EventId.make("settle-binding:item:late"),
      type: "turn-item.updated",
      threadId,
      runId: RunId.make("run:settle-binding:1"),
      occurredAt: now,
      payload: {
        id: commandItem(3),
        threadId,
        runId: RunId.make("run:settle-binding:1"),
        nodeId: NodeId.make("node:settle-binding:1"),
        providerThreadId,
        providerTurnId: ProviderTurnId.make("provider-turn:settle-binding:1"),
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 30,
        status: "running",
        title: "Late background command",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "command_execution",
        input: "sleep 3",
      },
    });
    const replayed = yield* orchestrator.dispatch(emptySettle);
    assert.lengthOf(replayed.storedEvents, 0);
    assert.deepEqual(yield* itemStatuses, [
      `${commandItem(1)}:interrupted`,
      `${commandItem(2)}:running`,
      `${commandItem(3)}:running`,
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps delegated child pull-request links independent of the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parentThreadId = ThreadId.make("thread:parent-pr");
    const projectId = ProjectId.make("project:parent-pr");
    const parentPullRequest = {
      projectId,
      repository: "pingdotgg/t3code",
      number: 123,
      url: "https://github.com/pingdotgg/t3code/pull/123",
    };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-parent-pr"),
      threadId: parentThreadId,
      projectId,
      title: "Parent with a linked PR",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/parent-pr",
      worktreePath: "/repo-worktree",
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-parent-pr"),
      threadId: parentThreadId,
      linkedPullRequest: parentPullRequest,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-parent-pr"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:parent-pr"),
      text: "Delegate a review",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parent = yield* projections.getThreadProjection(parentThreadId);
    const parentRun = parent.runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-parent-pr"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Review the changes",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const updatedParent = yield* projections.getThreadProjection(parentThreadId);
    const childThreadId = updatedParent.subagents[0]!.childThreadId!;
    const child = yield* projections.getThreadProjection(childThreadId);
    assert.isNull(child.thread.linkedPullRequest);
    assert.deepEqual(child.thread.pullRequests, []);
    assert.equal(child.thread.branch, parent.thread.branch);
    assert.equal(child.thread.worktreePath, parent.thread.worktreePath);
    assert.equal(child.thread.lineage.parentThreadId, parentThreadId);

    const childPullRequest = {
      ...parentPullRequest,
      number: 456,
      url: "https://github.com/pingdotgg/t3code/pull/456",
    };
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("link-child-pr"),
      threadId: childThreadId,
      linkedPullRequest: childPullRequest,
    });
    const linkedChild = yield* projections.getThreadProjection(childThreadId);
    assert.deepEqual(linkedChild.thread.linkedPullRequest, childPullRequest);
    assert.deepEqual(
      linkedChild.thread.pullRequests?.map((link) => link.number),
      [456],
    );
    const parentAfterChildLink = yield* projections.getThreadProjection(parentThreadId);
    assert.deepEqual(parentAfterChildLink.thread.linkedPullRequest, parentPullRequest);
    assert.deepEqual(parentAfterChildLink.thread.pullRequests, parent.thread.pullRequests);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("wakes the parent once when its delegated task asks a question", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
    const parentThreadId = ThreadId.make("thread:question-parent");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-question-parent"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:question"),
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("start-question-parent"),
      threadId: parentThreadId,
      messageId: MessageId.make("message:question-parent"),
      text: "Delegate the research",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* projections.getThreadProjection(parentThreadId)).runs[0]!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("delegate-question-task"),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Research the sources",
      completionWake: "settled_only",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const task = (yield* projections.getThreadProjection(parentThreadId)).subagents[0]!;
    const childRun = (yield* projections.getThreadRecords(task.childThreadId!, ["runs"])).runs[0]!;
    const now = yield* DateTime.now;
    const requestEvent = (
      eventId: string,
      requestId: string,
      responseCapability: "live" | "message" = "message",
      kind: "user_input" | "command" = "user_input",
      run = childRun,
    ) =>
      ({
        id: EventId.make(eventId),
        type: "runtime-request.updated",
        threadId: task.childThreadId!,
        runId: run.id,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make(requestId),
          nodeId: run.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind,
          status: "pending",
          responseCapability:
            responseCapability === "live"
              ? { type: "live", providerSessionId: ProviderSessionId.make("session:question") }
              : { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      }) satisfies OrchestrationV2DomainEvent;
    const question = requestEvent("event:question", "request:question", "live");
    const asyncQuestion = requestEvent("event:async-question", "request:async-question");
    const answered = requestEvent("event:answered", "request:answered", "live");
    const approval = requestEvent("event:approval", "request:approval", "message", "command");
    const eventSink = yield* EventSink.EventSinkV2;
    yield* eventSink.write({
      events: [question, asyncQuestion, answered, approval],
    });

    yield* reactor.handle(question);
    assert.isFalse(
      (yield* projections.getThreadProjection(parentThreadId)).messages.some(
        (message) => message.notification !== undefined,
      ),
    );
    yield* reactor.handle(asyncQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      1,
    );
    yield* reactor.handle(asyncQuestion);
    yield* reactor.handle(answered);
    yield* eventSink.write({
      events: [
        {
          ...answered,
          id: EventId.make("event:answered-resolved"),
          payload: { ...answered.payload, status: "resolved", resolvedAt: now },
        },
      ],
    });
    yield* reactor.handle(answered);
    yield* reactor.handle(approval);

    const wakes = (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
      (message) => message.notification !== undefined,
    );
    assert.include(wakes[0]?.text, "asked a question and is still working");
    assert.deepEqual(
      wakes.map((message) => message.notification),
      [
        {
          source: {
            kind: "delegated_task",
            taskIds: [task.id],
            childThreadId: task.childThreadId!,
          },
          outcome: "updated",
          summary: 'Delegated task "Research the sources" has a question',
        },
      ],
    );

    const wakeRun = (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs.find(
      (run) => run.userMessageId === wakes[0]!.id,
    )!;
    assert.equal(wakeRun.status, "queued");
    const resolved = {
      ...asyncQuestion,
      id: EventId.make("event:question-resolved"),
      payload: { ...asyncQuestion.payload, status: "resolved" as const, resolvedAt: now },
    };
    yield* eventSink.write({ events: [resolved] });
    yield* reactor.handle(resolved);
    assert.equal(
      (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs.find(
        (run) => run.id === wakeRun.id,
      )?.status,
      "cancelled",
    );
    const parentCompleted = {
      id: EventId.make("event:question-parent-completed"),
      type: "run.updated",
      threadId: parentThreadId,
      runId: parentRun.id,
      occurredAt: now,
      payload: { ...parentRun, status: "completed", completedAt: now },
    } satisfies OrchestrationV2DomainEvent;
    for (const status of [
      "preparing",
      "starting",
      "running",
      "queued",
      "cancelled",
      "rolled_back",
      "interrupted",
    ] as const) {
      yield* reactor.handle({ ...parentCompleted, payload: { ...parentRun, status } });
    }
    assert.equal(
      (yield* projections.getThreadRecords(parentThreadId, ["messages"])).messages.length,
      2,
    );
    yield* eventSink.write({ events: [parentCompleted] });
    for (const state of ["disposed", "pending"] as const) {
      yield* eventSink.write({
        events: [
          {
            id: EventId.make(`event:question-task-${state}`),
            type: "subagent.updated",
            threadId: parentThreadId,
            occurredAt: now,
            payload: { ...task, completionDelivery: { state, observedByRunId: null } },
          },
        ],
      });
      yield* reactor.handle(parentCompleted);
      if (state === "disposed") {
        assert.equal(
          (yield* projections.getThreadRecords(parentThreadId, ["messages"])).messages.length,
          2,
        );
      }
    }
    yield* reactor.handle(parentCompleted);
    const caughtUp = (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
      (message) => message.notification !== undefined,
    );
    assert.equal(caughtUp.length, 2);
    assert.equal(
      caughtUp.filter((message) => message.text.includes(`requestId ${question.payload.id}.`))
        .length,
      1,
    );
    assert.include(caughtUp[1]?.text, "is blocked on a question");
    assert.isFalse(
      caughtUp.some((message) => message.text.includes(`requestId ${answered.payload.id}.`)),
    );
    yield* reactor.handle(question);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      2,
    );
    const terminalQuestion = requestEvent(
      "event:terminal-question",
      "request:terminal-question",
      "live",
    );
    yield* eventSink.write({ events: [terminalQuestion] });
    yield* reactor.handle(terminalQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      3,
    );
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:question-parent-running-again"),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRun.id,
          occurredAt: now,
          payload: { ...parentRun, status: "running", completedAt: null },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("terminal-question-wait-ended"),
      parentThreadId,
      taskId: task.id,
      completionWake: "always",
    });
    const upgradedQuestion = requestEvent(
      "event:upgraded-question",
      "request:upgraded-question",
      "live",
    );
    yield* eventSink.write({ events: [upgradedQuestion] });
    yield* reactor.handle(upgradedQuestion);
    assert.equal(
      (yield* projections.getThreadProjection(parentThreadId)).messages.filter(
        (message) => message.notification !== undefined,
      ).length,
      4,
    );
    const waitDelivered = requestEvent("event:wait-delivered", "request:wait-delivered", "live");
    const waitDeliveredParentCompleted = {
      ...parentCompleted,
      id: EventId.make("event:wait-delivered-parent-completed"),
    };
    yield* eventSink.write({ events: [waitDelivered, waitDeliveredParentCompleted] });
    yield* reactor.handle(waitDeliveredParentCompleted);
    assert.isFalse(
      (yield* projections.getThreadProjection(parentThreadId)).messages.some((message) =>
        message.text.includes(`requestId ${waitDelivered.payload.id}.`),
      ),
    );
    yield* eventSink.write({
      commandId: CommandId.make("command:runtime-reconcile:question-followup"),
      events: [
        {
          id: EventId.make("event:question-child-completed"),
          type: "run.updated",
          threadId: task.childThreadId!,
          occurredAt: now,
          payload: { ...childRun, status: "completed", completedAt: now },
        },
        {
          id: EventId.make("event:question-task-completed"),
          type: "subagent.updated",
          threadId: parentThreadId,
          occurredAt: now,
          payload: {
            ...task,
            status: "completed",
            result: "Sources researched.",
            completedAt: now,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("question-followup"),
      threadId: task.childThreadId!,
      messageId: MessageId.make("message:question-followup"),
      text: "Check the sources again",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const followup = (yield* projections.getThreadRecords(task.childThreadId!, ["runs"])).runs.find(
      (run) => run.userMessageId === "message:question-followup",
    )!;
    assert.isDefined(followup.delegatedTaskId);
    assert.notEqual(followup.delegatedTaskId, task.id);
    const followupQuestion = requestEvent(
      "event:followup-question",
      "request:followup-question",
      "live",
      "user_input",
      followup,
    );
    yield* eventSink.write({ events: [followupQuestion] });
    yield* reactor.handle(followupQuestion);
    const followupWake = (yield* projections.getThreadRecords(parentThreadId, [
      "messages",
    ])).messages.find((message) =>
      message.text.includes(`requestId ${followupQuestion.payload.id}`),
    )!;
    assert.deepEqual(followupWake.notification?.source, {
      kind: "delegated_task",
      taskIds: [followup.delegatedTaskId],
      childThreadId: task.childThreadId!,
    });
  }).pipe(Effect.provide(DelegatedTaskQuestionReactor.layer.pipe(Layer.provideMerge(layerTest)))),
);

it.effect.each([false, true])("rejects thread.create for an existing id (deleted: %s)", (deleted) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:duplicate-create:${deleted}`);
    const create = {
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:duplicate-create"),
      title: "Original",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      importedNativeThread: {
        ref: { driver: adapter.driver, nativeId: "native-original", strength: "strong" },
      },
    } as const;
    yield* orchestrator.dispatch(create);
    if (deleted) {
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`delete:${threadId}`),
        threadId,
      });
    }
    const before = yield* projections.getThread(threadId);
    assert.isNotNull(before.activeProviderThreadId);
    assert.equal(before.deletedAt !== null, deleted);
    const sequence = yield* orchestrator.getThreadEventSequence(threadId);
    yield* TestClock.adjust("1 second");
    const duplicate = {
      ...create,
      commandId: CommandId.make(`duplicate:${threadId}`),
      title: "Replacement",
      importedNativeThread: undefined,
    };
    const outcome = yield* orchestrator.dispatch(duplicate).pipe(Effect.result);
    assert.ok(Result.isFailure(outcome), "duplicate create must be rejected");
    const refused = outcome.failure;
    assert.equal(refused._tag, "OrchestratorThreadAlreadyExistsError");
    assert.equal(refused.message, `Thread ${threadId} already exists. Use a new thread id.`);
    assert.deepEqual(yield* projections.getThread(threadId), before);
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
    const retried = yield* orchestrator.dispatch(duplicate).pipe(Effect.flip);
    assert.equal(retried._tag, "OrchestratorCommandPreviouslyRejectedError");
    assert.include(retried.message, refused.message);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("replays a thread.create receipt without changing the thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:create-receipt-replay");
    const create = {
      type: "thread.create",
      commandId: CommandId.make("create:receipt-replay"),
      threadId,
      projectId: ProjectId.make("project:duplicate-create"),
      title: "Original",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    } as const;
    const original = yield* orchestrator.dispatch(create);
    const before = yield* projections.getThread(threadId);
    const replayed = yield* orchestrator.dispatch(create);
    assert.equal(replayed.sequence, original.sequence);
    // Marked so client analytics do not count the retry again.
    assert.deepEqual(replayed, { ...original, replayed: true });
    assert.deepEqual(yield* projections.getThread(threadId), before);
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), original.sequence);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("explicit settle clears snooze atomically and stays idempotent after re-snoozing", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:settle-snoozed");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-settle-snoozed"),
      threadId,
      projectId: ProjectId.make("project:settle-snoozed"),
      title: "Snoozed thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const settledAt = DateTime.add(now, { seconds: 1 });
    const snoozedUntil = DateTime.add(now, { hours: 1 });
    for (const round of [1, 2]) {
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make(`snooze-before-settle-${round}`),
        threadId,
        snoozedUntil: DateTime.formatIso(snoozedUntil),
      });
      assert.deepInclude(yield* projections.getThread(threadId), {
        snoozedUntil,
        snoozedAt: yield* DateTime.now,
      });
      yield* TestClock.adjust("1 second");
      const commandId = CommandId.make(`settle-snoozed-${round}`);
      yield* orchestrator.dispatch({ type: "thread.settle", commandId, threadId });
      const expected = {
        settledOverride: "settled",
        settledAt,
        snoozedUntil: null,
        snoozedAt: null,
        updatedAt: yield* DateTime.now,
      } as const;
      const committed = yield* events.readByCommandId({ commandId }).pipe(Stream.runCollect);
      assert.lengthOf(committed, 1);
      assert.equal(committed[0]?.event.type, "thread.settled");
      assert.deepInclude(committed[0]?.event.payload, expected);
      const settled = yield* projections.getThreadShell(threadId);
      assert.deepInclude(settled, expected);
      assert.deepInclude((yield* projections.getThreadProjection(threadId)).thread, expected);

      yield* TestClock.adjust("1 second");
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`settle-again-${round}`),
        threadId,
      });
      assert.deepEqual(yield* projections.getThreadShell(threadId), settled);
    }
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("unsettle-after-snooze"),
      threadId,
      reason: "user",
    });
    const active = {
      settledOverride: "active",
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
    } as const;
    assert.deepInclude(yield* projections.getThreadShell(threadId), active);
    assert.deepInclude((yield* projections.getThreadProjection(threadId)).thread, active);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("commits temporary roots with storage ownership and preserves the temporary flag", () => {
  const threadId = ThreadId.make("thread:temporary-root");
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      temporary: true,
      threadId,
      commandId: CommandId.make("temporary-root-create"),
      projectId: ProjectId.make("project:temporary"),
      title: "Temporary",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    assert.isTrue(yield* storage.isTemporary(threadId));
    assert.isTrue((yield* orchestrator.getThreadRecords(threadId, [])).thread.temporary);
  }).pipe(Effect.provide(layerTemporaryTest));
});

it.effect.each(["missing", "accepted", "rejected"] as const)(
  "temporary fork rejects a %s receipt without registering its target",
  (receipt) =>
    Effect.gen(function* () {
      const parentThreadId = yield* createTemporaryParent;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
      const targetThreadId = ThreadId.make("thread:temporary-fork-target");
      const commandId = CommandId.make("temporary-fork");
      if (receipt !== "missing") {
        yield* stores.durable.commandReceipts.insertIfAbsent({
          commandId,
          threadId: targetThreadId,
          commandType: "thread.fork",
          acceptedAt: yield* DateTime.now,
          resultSequence: 0,
          status: receipt,
          error: receipt === "rejected" ? "Earlier failure" : null,
        });
      }
      const before = yield* stores.durable.commandReceipts.getByCommandId(commandId);
      const error = yield* Effect.flip(
        orchestrator.dispatch({
          type: "thread.fork",
          commandId,
          sourceThreadId: parentThreadId,
          targetThreadId,
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        }),
      );
      assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
      if (error._tag === "OrchestratorDispatchError") {
        assert.equal(error.cause, "Keep this thread before using this operation.");
      }
      assert.deepEqual(yield* storage.family(parentThreadId), [parentThreadId]);
      assert.isFalse(yield* storage.isTemporary(targetThreadId));
      assert.isNull(yield* stores.volatile.projectionStore.getThreadShell(targetThreadId));
      assert.isNull(yield* stores.durable.projectionStore.getThreadShell(targetThreadId));
      assert.deepEqual(yield* stores.durable.commandReceipts.getByCommandId(commandId), before);
      assert.isTrue(
        Option.isNone(yield* stores.volatile.commandReceipts.getByCommandId(commandId)),
      );
    }).pipe(Effect.provide(layerTemporaryTest)),
);

it.effect.each(["invalid-parent", "accepted-replay", "rejected-replay"] as const)(
  "temporary delegated request with %s leaves no phantom child",
  (scenario) =>
    Effect.gen(function* () {
      const parentThreadId = yield* createTemporaryParent;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const command = {
        type: "delegated_task.request",
        commandId: CommandId.make("temporary-invalid-delegate"),
        parentThreadId,
        parentRunId: RunId.make("missing-run"),
        parentNodeId: NodeId.make("missing-node"),
        task: "Child task",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      } as const;
      if (scenario === "accepted-replay") {
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: command.commandId,
          threadId: parentThreadId,
          title: "Accepted earlier",
        });
      } else if (scenario === "rejected-replay") {
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.commitRejectedCommand({
          commandId: command.commandId,
          threadId: parentThreadId,
          commandType: command.type,
          rejectedAt: yield* DateTime.now,
          error: "Earlier failure",
        });
      }
      const result = yield* Effect.result(orchestrator.dispatch(command));
      if (scenario === "accepted-replay") {
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) assert.isTrue(result.success.replayed);
      } else {
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.equal(
            result.failure._tag,
            scenario === "invalid-parent"
              ? "OrchestratorDispatchError"
              : "OrchestratorCommandPreviouslyRejectedError",
          );
          if (result.failure._tag === "OrchestratorDispatchError") {
            assert.equal(result.failure.cause, "Parent run missing-run is not active.");
          }
        }
      }
      const childId = allocator.derive.delegatedTaskThread({ commandId: command.commandId });
      assert.deepEqual(yield* storage.family(parentThreadId), [parentThreadId]);
      assert.isFalse(yield* storage.isTemporary(childId));
      assert.isNull(yield* stores.volatile.projectionStore.getThreadShell(childId));
      assert.isNull(yield* stores.durable.projectionStore.getThreadShell(childId));
      assert.isTrue(
        Option.isNone(yield* stores.durable.commandReceipts.getByCommandId(command.commandId)),
      );
      const receipt = Option.getOrThrow(
        yield* stores.volatile.commandReceipts.getByCommandId(command.commandId),
      );
      assert.equal(receipt.status, scenario === "accepted-replay" ? "accepted" : "rejected");
    }).pipe(Effect.provide(layerTemporaryTest)),
);

it.effect.each([false, true])(
  "temporary child creation inherits ownership after transaction failure=%s and closed families reject new work",
  (failFirst) =>
    Effect.gen(function* () {
      const parentThreadId = yield* createTemporaryParent;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
      const state = yield* TemporaryThreadService.TemporaryThreadLifecycleState;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("temporary-parent-start"),
        threadId: parentThreadId,
        messageId: MessageId.make("temporary-parent-message"),
        text: "Run a child",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const parent = yield* orchestrator.getThreadRecords(parentThreadId, ["runs"]);
      const run = parent.runs[0]!;
      const command = {
        type: "delegated_task.request",
        commandId: CommandId.make("temporary-parent-delegate"),
        parentThreadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Child task",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      } as const;
      if (failFirst) {
        const eventsBefore = yield* stores.volatile.sql`SELECT * FROM orchestration_events`;
        yield* stores.volatile
          .sql`CREATE TRIGGER reject_child BEFORE INSERT ON orchestration_v2_projection_threads BEGIN SELECT RAISE(ABORT, 'test child failure'); END`;
        const error = yield* orchestrator.dispatch(command).pipe(Effect.flip);
        assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
        assert.deepEqual(yield* storage.family(parentThreadId), [parentThreadId]);
        assert.deepEqual(
          yield* stores.volatile.sql`SELECT * FROM orchestration_events`,
          eventsBefore,
        );
        assert.isTrue(
          Option.isNone(yield* stores.volatile.commandReceipts.getByCommandId(command.commandId)),
        );
        yield* stores.volatile.sql`DROP TRIGGER reject_child`;
      }
      const accepted = yield* orchestrator.dispatch(command);
      const updated = yield* orchestrator.getThreadRecords(parentThreadId, ["subagents"]);
      const childId = updated.subagents[0]!.childThreadId!;
      assert.deepEqual(yield* storage.family(parentThreadId), [parentThreadId, childId]);
      const child = yield* orchestrator.getThreadRecords(childId, ["providerThreads"]);
      assert.isTrue(child.thread.temporary);
      const allocator = yield* IdAllocator.IdAllocatorV2;
      assert.isNotEmpty(child.providerThreads);
      assert.notEqual(
        child.providerThreads[0]!.providerSessionId,
        allocator.derive.providerSession({ providerInstanceId: instanceId }),
      );
      assert.isNotNull(yield* stores.volatile.projectionStore.getThreadShell(childId));
      assert.isNull(yield* stores.durable.projectionStore.getThreadShell(childId));
      const effectsBefore = yield* stores.volatile
        .sql`SELECT * FROM orchestration_v2_effect_outbox`;
      assert.isAbove(effectsBefore.length, 0);
      const replayed = yield* orchestrator.dispatch(command);
      assert.isTrue(replayed.replayed);
      assert.equal(replayed.sequence, accepted.sequence);
      assert.deepEqual(
        replayed.storedEvents.map((stored) => stored.event.id),
        accepted.storedEvents.map((stored) => stored.event.id),
      );
      assert.deepEqual(
        yield* stores.volatile.sql`SELECT * FROM orchestration_v2_effect_outbox`,
        effectsBefore,
      );
      for (const table of [
        "orchestration_events",
        "orchestration_command_receipts",
        "orchestration_v2_projection_threads",
        "orchestration_v2_effect_outbox",
      ]) {
        assert.isEmpty(yield* stores.durable.sql.unsafe(`SELECT * FROM ${table}`));
      }
      state.discarding.add(parentThreadId);
      assert.isTrue(
        Result.isFailure(
          yield* Effect.result(
            orchestrator.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("temporary-late-update"),
              threadId: childId,
              title: "Late work",
            }),
          ),
        ),
      );
      assert.notEqual(
        (yield* orchestrator.getThreadRecords(childId, [])).thread.title,
        "Late work",
      );
      const closed = yield* Effect.flip(orchestrator.dispatch(command));
      assert.instanceOf(closed, Orchestrator.OrchestratorDispatchError);
      if (closed._tag === "OrchestratorDispatchError") {
        assert.equal(closed.cause, "Temporary thread is closed.");
      }
      yield* storage.discard(parentThreadId);
      state.discarding.delete(parentThreadId);
      const discarded = yield* Effect.flip(orchestrator.dispatch(command));
      assert.instanceOf(discarded, Orchestrator.OrchestratorDispatchError);
      if (discarded._tag === "OrchestratorDispatchError") {
        assert.equal(discarded.cause, "Temporary thread is closed.");
      }
    }).pipe(Effect.provide(layerTemporaryTest)),
);

it.effect.each([
  ["selection", "other-codex", true, true],
  ["message", "other-codex", true, true],
  ["switch", "other-codex", true, true],
  ["selection", "other-claude", true, true],
  ["message", "other-claude", true, true],
  ["switch", "other-claude", true, true],
  ["switch", "codex", true, false],
  ["switch", "other-codex", false, false],
  ["runtime-mode", "codex", true, true, false],
  ["runtime-mode", "codex", true, false, true],
  ["runtime-mode", "codex", true, false, false, false],
  ["runtime-mode", "codex", false, false, false],
] as const)(
  "%s to %s with temporary=%s rejects=%s before changing a live session",
  ([
    operation,
    target,
    temporary,
    rejects,
    supportsRuntimeModeSwitchInSession = true,
    hasSession = true,
  ]) => {
    const threadId = ThreadId.make("thread:temporary-provider-switch");
    const otherSelection = { instanceId: ProviderInstanceId.make(target), model: "test" };
    const owned = new Set<ThreadId>(temporary ? [threadId] : []);
    const storageLayer = Layer.mock(TemporaryThreadStorage.TemporaryThreadStorage)({
      register: ({ threadId: id }) =>
        Effect.sync(() => {
          owned.add(id);
        }),
      isTemporary: (id) => Effect.sync(() => owned.has(id)),
      isDiscarded: () => Effect.succeed(false),
      family: (id) => Effect.succeed([id]),
    });
    const engineLayer = ProviderReplayHarness.layerWithRegistry(
      { name: "temporary-provider-switch" },
      ProviderAdapterRegistry.layerFromAdapters([
        adapter,
        { ...adapter, instanceId: ProviderInstanceId.make("other-codex") },
        {
          ...adapter,
          instanceId: ProviderInstanceId.make("other-claude"),
          driver: ProviderDriverKind.make("claude"),
        },
      ]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ).pipe(Layer.provide(storageLayer));
    const storesLayer = Layer.mergeAll(ProjectionStore.layer, EffectOutbox.layer).pipe(
      Layer.provide(layerDatabase),
    );
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        temporary,
        threadId,
        commandId: CommandId.make("temporary-switch-create"),
        projectId: ProjectId.make("project:temporary-switch"),
        title: "Temporary",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const now = yield* DateTime.now;
      const sessionId = ProviderSessionId.make("temporary-switch-session");
      if (hasSession)
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("temporary-switch-session-attached"),
              type: "provider-session.attached",
              threadId,
              occurredAt: now,
              payload: {
                id: sessionId,
                driver: adapter.driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd: "/repo",
                model: modelSelection.model,
                capabilities: {
                  ...CodexProviderCapabilitiesV2,
                  sessions: {
                    ...CodexProviderCapabilitiesV2.sessions,
                    supportsProviderSwitchingViaHandoff: false,
                    supportsRuntimeModeSwitchInSession,
                  },
                },
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
            },
          ],
        });
      const before = yield* projections.getThreadProviderContext(threadId);
      const sequence = yield* orchestrator.getThreadEventSequence(threadId);
      const commandId = CommandId.make("temporary-switch");
      const refused = yield* Effect.result(
        orchestrator.dispatch(
          operation === "runtime-mode"
            ? {
                type: "thread.runtime-mode.set",
                commandId,
                threadId,
                runtimeMode: "approval-required",
              }
            : operation !== "message"
              ? {
                  type:
                    operation === "selection" ? "thread.model-selection.set" : "provider.switch",
                  commandId,
                  threadId,
                  modelSelection: otherSelection,
                }
              : {
                  type: "message.dispatch",
                  commandId,
                  threadId,
                  modelSelection: otherSelection,
                  messageId: MessageId.make("temporary-switch-message"),
                  text: "Switch provider",
                  attachments: [],
                  dispatchMode: { type: "start_immediately" },
                  createdBy: "user",
                  creationSource: "web",
                },
        ),
      );
      assert.equal(Result.isFailure(refused), rejects);
      const projection = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      assert.isEmpty(projection.runs);
      if (rejects) {
        if (operation === "runtime-mode" && Result.isFailure(refused)) {
          assert.instanceOf(refused.failure, Orchestrator.OrchestratorDispatchError);
          if (refused.failure._tag === "OrchestratorDispatchError") {
            assert.equal(refused.failure.cause, "Keep this thread before using this operation.");
          }
        }
        assert.deepEqual(yield* projections.getThreadProviderContext(threadId), before);
        assert.equal(yield* orchestrator.getThreadEventSequence(threadId), sequence);
        assert.isEmpty(yield* eventSink.readByCommandId({ commandId }).pipe(Stream.runCollect));
        assert.isEmpty(yield* outbox.listByCommandId(commandId));
      } else {
        if (operation === "runtime-mode") {
          assert.equal(projection.thread.runtimeMode, "approval-required");
          assert.deepEqual(projection.thread.modelSelection, modelSelection);
        } else {
          assert.deepEqual(projection.thread.modelSelection, otherSelection);
        }
        if (temporary) {
          assert.equal(
            (yield* projections.getThreadProviderContext(threadId)).providerSessions[0]?.id,
            hasSession ? sessionId : undefined,
          );
          assert.isEmpty(yield* outbox.listByCommandId(commandId));
        }
      }
    }).pipe(Effect.provide(Layer.merge(engineLayer, storesLayer)));
  },
);

it.effect("dispatch records the command outcome and its duration", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const successes = Metric.value(
      Metric.withAttributes(orchestrationCommandsTotal, {
        commandType: "thread.create",
        outcome: "success",
      }),
    );
    const durations = Metric.value(
      Metric.withAttributes(orchestrationCommandDuration, { commandType: "thread.create" }),
    );
    const successesBefore = (yield* successes).count;
    const durationsBefore = (yield* durations).count;

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-dispatch-metrics"),
      threadId: ThreadId.make("thread:dispatch-metrics"),
      projectId: ProjectId.make("project:dispatch-metrics"),
      title: "Dispatch metrics",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });

    assert.strictEqual((yield* successes).count - successesBefore, 1);
    assert.strictEqual((yield* durations).count - durationsBefore, 1);
  }).pipe(Effect.provide(layerTest)),
);

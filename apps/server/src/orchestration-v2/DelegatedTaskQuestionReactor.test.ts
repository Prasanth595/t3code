import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as DelegatedTaskQuestionReactor from "./DelegatedTaskQuestionReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
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
  openSession: () => Effect.die("No provider process needed for delegated task questions"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerProjections = ProjectionStore.layer.pipe(Layer.provide(layerDatabase));
const layerHarness = ProviderReplayHarness.layerWithRegistry(
  { name: "delegated-task-question" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: layerDatabase, runEffectWorker: false },
);
const layerTest = DelegatedTaskQuestionReactor.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(layerDatabase, layerProjections, layerHarness)),
);

const requestEvent = (input: {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly kind: OrchestrationV2RuntimeRequest["kind"];
  readonly status?: OrchestrationV2RuntimeRequest["status"];
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${input.requestId}`),
  type: "runtime-request.updated",
  threadId: input.threadId,
  occurredAt: input.now,
  payload: {
    id: RuntimeRequestId.make(input.requestId),
    nodeId: NodeId.make(`node:${input.requestId}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: input.kind,
    status: input.status ?? "pending",
    responseCapability: { type: "message" },
    createdAt: input.now,
    resolvedAt: null,
  },
});

const seedDelegatedTask = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
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
    task: "Research the official questions",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    completionWake: "always",
    createdBy: "agent",
    creationSource: "mcp",
  });
  const task = (yield* projections.getThreadProjection(parentThreadId)).subagents[0]!;
  return { parentThreadId, childThreadId: task.childThreadId!, taskId: task.id };
});

const notificationMessages = (threadId: ThreadId) =>
  ProjectionStore.ProjectionStoreV2.pipe(
    Effect.flatMap((projections) => projections.getThreadProjection(threadId)),
    Effect.map((projection) =>
      projection.messages.filter((message) => message.notification !== undefined),
    ),
  );

it.effect("wakes the parent once when its delegated task asks a question", () =>
  Effect.gen(function* () {
    const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
    const { parentThreadId, childThreadId, taskId } = yield* seedDelegatedTask;
    const now = yield* DateTime.now;
    const question = requestEvent({
      threadId: childThreadId,
      requestId: "request:question",
      kind: "user_input",
      now,
    });

    yield* reactor.handle(question);
    // The same request updated while pending must not queue a second wake.
    yield* reactor.handle(question);

    const messages = yield* notificationMessages(parentThreadId);
    assert.equal(messages.length, 1);
    const [message] = messages;
    assert.deepEqual(message?.notification, {
      source: { kind: "delegated_task", taskIds: [taskId], childThreadId },
      outcome: "updated",
      summary: 'Delegated task "Research the official questions" has a question',
    });
    assert.include(message?.text, `threadId ${childThreadId}`);
    assert.include(message?.text, "t3_pending_request_respond");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ignores approvals, answered questions and questions outside delegated tasks", () =>
  Effect.gen(function* () {
    const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
    const { parentThreadId, childThreadId } = yield* seedDelegatedTask;
    const now = yield* DateTime.now;

    yield* reactor.handle(
      requestEvent({
        threadId: childThreadId,
        requestId: "request:approval",
        kind: "command",
        now,
      }),
    );
    yield* reactor.handle(
      requestEvent({
        threadId: childThreadId,
        requestId: "request:answered",
        kind: "user_input",
        status: "resolved",
        now,
      }),
    );
    yield* reactor.handle(
      requestEvent({
        threadId: parentThreadId,
        requestId: "request:parent-question",
        kind: "user_input",
        now,
      }),
    );

    assert.deepEqual(yield* notificationMessages(parentThreadId), []);
  }).pipe(Effect.provide(layerTest)),
);

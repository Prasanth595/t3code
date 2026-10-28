import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

// A delegated task whose child runs in a linked environment is recorded on
// its parent without a child thread here, and completing it wakes the parent
// the way a local child's result does.

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for delegated task records"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** Every parent wake the orchestrator offers, for the tests to read. */
class Offers extends Context.Service<
  Offers,
  Ref.Ref<ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>>
>()("t3/orchestration-v2/RemoteDelegatedTask.test/Offers") {}
const layerOffers = Layer.effect(
  Offers,
  Ref.make<ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>>([]),
);
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "remote-delegated-task" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
).pipe(
  Layer.provide(
    Layer.effect(
      ProviderContinuationRequests.ProviderContinuationRequests,
      Offers.pipe(
        Effect.map((offers) => ({
          offer: (request: ProviderContinuationRequests.ProviderContinuationRequest) =>
            Ref.update(offers, (seen) => [...seen, request]),
          take: Effect.never,
        })),
      ),
    ),
  ),
  Layer.provideMerge(layerOffers),
);

/** A parent thread whose run is live, as when its agent calls delegate_task. */
const seedLiveParent = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:${name}`);
    const runId = RunId.make(`run:${name}`);
    const rootNodeId = NodeId.make(`node:${name}:root`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:create:${name}`),
      threadId,
      projectId: ProjectId.make("project:remote-delegated-task"),
      title: "Parent",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* sink.write({
      commandId: CommandId.make(`command:seed:${name}`),
      events: [
        {
          id: EventId.make(`event:seed-provider-thread:${name}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: rootNodeId,
            nativeThreadRef: { driver, nativeId: `native:${name}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`event:seed-node:${name}`),
          type: "node.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: rootNodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make(`event:seed-run:${name}`),
          type: "run.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:seed-user:${name}`),
            rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    return { threadId, runId, rootNodeId };
  });

const remoteChild = {
  environmentId: EnvironmentId.make("environment:box"),
  threadId: ThreadId.make("thread:on-the-box"),
  label: "Box",
};

/** A live parent with one task delegated to a linked environment, still running there. */
const delegateRemotely = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parent = yield* seedLiveParent(name);
    yield* orchestrator.dispatch({
      type: "delegated_task.remote.request",
      commandId: CommandId.make(`command:remote-delegate:${name}`),
      parentThreadId: parent.threadId,
      parentRunId: parent.runId,
      parentNodeId: parent.rootNodeId,
      task: "Run a check.",
      driver: ProviderDriverKind.make("remote"),
      modelSelection,
      remoteChild,
    });
    const taskId = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!.id;
    return { parent, taskId };
  });

it.layer(layerTest)("a delegated task in a linked environment", (it) => {
  it.effect("is recorded on its parent without a child thread here, once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = yield* seedLiveParent("records");
      const request = {
        type: "delegated_task.remote.request" as const,
        commandId: CommandId.make("command:remote-delegate:records"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run the suite there.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection,
        remoteChild,
        completionWake: "always" as const,
      };
      yield* orchestrator.dispatch(request);
      yield* orchestrator.dispatch(request);
      const projection = yield* orchestrator.getThreadProjection(parent.threadId);
      assert.equal(projection.subagents.length, 1);
      const [task] = projection.subagents;
      assert.equal(task?.childThreadId, null);
      assert.deepEqual(task?.remoteChild, remoteChild);
      assert.equal(task?.status, "running");
      const item = projection.turnItems.find((candidate) => candidate.type === "subagent");
      assert.deepEqual(item?.type === "subagent" ? item.remoteChild : undefined, remoteChild);
      // No thread was created here for the child.
      assert.equal(yield* orchestrator.getThreadShell(remoteChild.threadId), null);
    }),
  );

  it.effect("keeps a newer stop recoverable after an older acknowledgement", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = yield* seedLiveParent("stop-generation");
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.request",
        commandId: CommandId.make("command:remote-delegate:stop-generation"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run a check.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection,
        remoteChild,
      });
      const task = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      const openFor = projections.getOpenRemoteDelegatedTasks.pipe(
        Effect.map((open) => open.filter((entry) => entry.parentThreadId === parent.threadId)),
      );
      const complete = {
        type: "delegated_task.remote.complete" as const,
        parentThreadId: parent.threadId,
        taskId: task.id,
        status: "completed" as const,
        result: "Original result.",
      };
      yield* orchestrator.dispatch({
        ...complete,
        commandId: CommandId.make("command:result:stop-generation"),
        stoppedThere: "ran-out",
      });
      for (const count of [1, 2]) {
        yield* orchestrator.dispatch({
          type: "delegated_task.remote.stop",
          parentThreadId: parent.threadId,
          taskId: task.id,
          commandId: CommandId.make(`command:stop-generation:${count}`),
        });
      }
      // Reports from before generation tracking cannot clear a later numbered Stop either.
      for (const stopCount of [undefined, 1]) {
        const rejected = yield* orchestrator
          .dispatch({
            ...complete,
            commandId: CommandId.make(`command:stale-stop:${stopCount}`),
            stoppedThere: "stopped",
            ...(stopCount === undefined ? {} : { stopCount }),
          })
          .pipe(Effect.flip);
        assert.equal(rejected._tag, "OrchestratorDispatchError");
        assert.deepEqual(yield* openFor, [{ parentThreadId: parent.threadId, taskId: task.id }]);
      }
      yield* orchestrator.dispatch({
        ...complete,
        commandId: CommandId.make("command:current-stop:2"),
        stoppedThere: "stopped",
        stopCount: 2,
      });
      const settled = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      assert.equal(settled.result, "Original result.");
      assert.equal(settled.status, "completed");
      assert.equal(settled.remoteChild?.stoppedThere, true);
      assert.deepEqual(yield* openFor, []);
    }),
  );

  it.effect("owes a stop there for a Stop here that loses the race to its result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = yield* seedLiveParent("stop-after-result");
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.request",
        commandId: CommandId.make("command:remote-delegate:stop-after-result"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run a check.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection,
        remoteChild,
      });
      const task = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      const complete = {
        type: "delegated_task.remote.complete" as const,
        parentThreadId: parent.threadId,
        taskId: task.id,
      };
      yield* orchestrator.dispatch({
        ...complete,
        commandId: CommandId.make("command:result:stop-after-result"),
        status: "completed",
        result: "Done there.",
        stoppedThere: "ran-out",
      });
      // The parent's Stop read the task before its result landed.
      yield* orchestrator.dispatch({
        ...complete,
        commandId: CommandId.make("command:parent-stop:stop-after-result"),
        status: "interrupted",
        result: "Stopped with its parent.",
      });

      const stopped = (yield* orchestrator.getThreadProjection(parent.threadId)).subagents[0]!;
      assert.equal(stopped.status, "completed");
      assert.equal(stopped.result, "Done there.");
      assert.equal(stopped.remoteChild?.stoppedThere, false);
      assert.equal(stopped.remoteChild?.stopCount, 1);
      const open = yield* projections.getOpenRemoteDelegatedTasks;
      assert.deepEqual(
        open.filter((entry) => entry.parentThreadId === parent.threadId),
        [{ parentThreadId: parent.threadId, taskId: task.id }],
      );
    }),
  );

  it.effect("wakes its parent with the result when it completes there", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = yield* seedLiveParent("completes");
      const recorded = yield* orchestrator.dispatch({
        type: "delegated_task.remote.request",
        commandId: CommandId.make("command:remote-delegate:completes"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run the suite there.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection,
        remoteChild,
        completionWake: "always",
      });
      const taskEvent = recorded.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      const taskId =
        taskEvent?.event.type === "subagent.updated" ? taskEvent.event.payload.id : undefined;
      assert.isDefined(taskId);
      // Until it completes, it is open, and a restarted follower picks it up.
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const openFor = projections.getOpenRemoteDelegatedTasks.pipe(
        Effect.map((open) => open.filter((task) => task.parentThreadId === parent.threadId)),
      );
      assert.deepEqual(yield* openFor, [{ parentThreadId: parent.threadId, taskId: taskId! }]);
      const offers = yield* Offers;
      yield* Ref.set(offers, []);
      const complete = (result: string) =>
        orchestrator.dispatch({
          type: "delegated_task.remote.complete",
          commandId: CommandId.make(`command:remote-complete:${result}`),
          parentThreadId: parent.threadId,
          taskId: taskId!,
          status: "completed",
          result,
          stoppedThere: "ran-out",
        });
      yield* complete("All 412 tests pass on the box.");
      // A second report is refused, so the first result stands.
      const late = yield* complete("A late, different answer.").pipe(Effect.flip);
      assert.equal(late._tag, "OrchestratorDispatchError");

      const projection = yield* orchestrator.getThreadProjection(parent.threadId);
      const task = projection.subagents.find((candidate) => candidate.id === taskId);
      assert.equal(task?.status, "completed");
      assert.equal(task?.result, "All 412 tests pass on the box.");
      // The live parent run claimed it, so task_status acknowledges it as for a local child.
      assert.equal(task?.completionDelivery?.state, "claimed");
      // Nothing is left for the follower to pick up after a restart.
      assert.deepEqual(yield* openFor, []);
      const item = projection.turnItems.find(
        (candidate) => candidate.type === "subagent" && candidate.subagentId === taskId,
      );
      assert.equal(item?.status, "completed");
      // The parent's live run is offered the delivery, as for a local child.
      const delivery = projection.runs.find((run) => run.id === parent.runId)?.delegatedCompletion
        ?.delivery;
      assert.deepEqual(delivery?.taskIds, [taskId]);
      const offered = yield* Ref.get(offers);
      assert.equal(offered.length, 1);
      assert.equal(offered[0]?.threadId, parent.threadId);
    }),
  );
  it.effect("shows its thread's questions and approvals there on the parent, answered here", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { parent, taskId } = yield* delegateRemotely("mirrors");
      const now = yield* DateTime.now;
      const approval = {
        requestId: RuntimeRequestId.make("request:there:approval"),
        kind: "command" as const,
        createdAt: now,
        detail: "rm -rf build",
      };
      const question = {
        requestId: RuntimeRequestId.make("request:there:question"),
        kind: "user_input" as const,
        createdAt: DateTime.add(now, { seconds: 1 }),
        questions: [{ id: "size", header: "Size", question: "Which size?", options: [] }],
      };
      const mirror = (name: string, requests: ReadonlyArray<typeof approval | typeof question>) =>
        orchestrator.dispatch({
          type: "delegated_task.remote.requests",
          commandId: CommandId.make(`command:mirror:${name}`),
          parentThreadId: parent.threadId,
          taskId,
          requests,
        });
      const pending = orchestrator
        .getThreadShell(parent.threadId)
        .pipe(Effect.map((shell) => shell?.pendingRuntimeRequest?.id ?? null));

      yield* mirror("both", [approval, question]);
      assert.equal(yield* pending, question.requestId);

      const wrongAnswer = yield* orchestrator
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("command:answer-approval-with-text"),
          threadId: parent.threadId,
          requestId: approval.requestId,
          answers: { size: "Large" },
        })
        .pipe(Effect.flip);
      assert.equal(wrongAnswer._tag, "OrchestratorDispatchError");
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("command:answer-question"),
        threadId: parent.threadId,
        requestId: question.requestId,
        answers: { size: "Large" },
      });
      // Answered here, the question waits on the relay, and the approval is what is left.
      assert.equal(yield* pending, approval.requestId);
      const answeredTwice = yield* orchestrator
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("command:answer-question-again"),
          threadId: parent.threadId,
          requestId: question.requestId,
          answers: { size: "Small" },
        })
        .pipe(Effect.flip);
      assert.equal(answeredTwice._tag, "OrchestratorDispatchError");

      // The follower reads both still waiting there; the answer given here stands.
      yield* mirror("both-again", [approval, question]);
      const requests = (yield* orchestrator.getThreadProjection(parent.threadId)).thread
        .remoteTaskRequests;
      assert.deepEqual(
        requests?.map((request) => [request.requestId, request.response]),
        [
          [approval.requestId, undefined],
          [question.requestId, { answers: { size: "Large" } }],
        ],
      );

      // The question left the thread there once it got the answer.
      yield* mirror("approval", [approval]);
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(parent.threadId)).thread.remoteTaskRequests?.map(
          (request) => request.requestId,
        ),
        [approval.requestId],
      );

      yield* orchestrator.dispatch({
        type: "delegated_task.remote.complete",
        commandId: CommandId.make("command:complete:mirrors"),
        parentThreadId: parent.threadId,
        taskId,
        status: "completed",
        result: "Done there.",
        stoppedThere: "ran-out",
      });
      assert.equal(yield* pending, null);
      // A late report from the follower mirrors nothing for a task that has its result.
      yield* mirror("late", [approval]);
      assert.equal(yield* pending, null);
    }),
  );

  it.effect("records nothing when a task there still waits on what the parent shows", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { parent, taskId } = yield* delegateRemotely("unchanged");
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.request",
        commandId: CommandId.make("command:remote-delegate:unchanged-second"),
        parentThreadId: parent.threadId,
        parentRunId: parent.runId,
        parentNodeId: parent.rootNodeId,
        task: "Run another check.",
        driver: ProviderDriverKind.make("remote"),
        modelSelection,
        remoteChild,
      });
      const secondTaskId = (yield* orchestrator.getThreadProjection(
        parent.threadId,
      )).subagents.find((task) => task.id !== taskId)!.id;
      const now = yield* DateTime.now;
      const mirror = (name: string, task: NodeId) =>
        orchestrator.dispatch({
          type: "delegated_task.remote.requests",
          commandId: CommandId.make(`command:mirror:unchanged:${name}`),
          parentThreadId: parent.threadId,
          taskId: task,
          requests: [
            {
              requestId: RuntimeRequestId.make(`request:there:${task}`),
              kind: "command",
              createdAt: now,
            },
          ],
        });
      yield* mirror("first", taskId);
      yield* mirror("second", secondTaskId);
      // A restarted follower mirrors the first task's requests again.
      const again = yield* mirror("first-again", taskId);
      assert.deepEqual(again.storedEvents, []);
    }),
  );

  it.effect("asks again here for an answer that could not reach its thread there", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { parent, taskId } = yield* delegateRemotely("respond-fails");
      const requestId = RuntimeRequestId.make("request:there:refused");
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.requests",
        commandId: CommandId.make("command:mirror:respond-fails"),
        parentThreadId: parent.threadId,
        taskId,
        requests: [{ requestId, kind: "command", createdAt: yield* DateTime.now }],
      });
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("command:approve:respond-fails"),
        threadId: parent.threadId,
        requestId,
        decision: "accept",
      });
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.respond.fail",
        commandId: CommandId.make("command:refused:respond-fails"),
        parentThreadId: parent.threadId,
        taskId,
        requestId,
        message: "This link is read-only.",
      });

      const projection = yield* orchestrator.getThreadProjection(parent.threadId);
      assert.equal(projection.thread.remoteTaskRequests?.[0]?.response, undefined);
      assert.equal(
        (yield* orchestrator.getThreadShell(parent.threadId))?.pendingRuntimeRequest?.id,
        requestId,
      );
      const failure = projection.turnItems.find((item) => item.type === "error");
      assert.equal(
        failure?.type === "error" ? failure.failure.message : undefined,
        "This link is read-only.",
      );
    }),
  );
});

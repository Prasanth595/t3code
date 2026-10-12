import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventStore from "./EventStore.ts";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-delegated-completion-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  // No supportedRuntimeModes: every runtime mode runs as stored.
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

const makeLayerTest = (
  persistence:
    | ReturnType<typeof SqlitePersistence.layerFromPath>
    | typeof SqlitePersistence.layerMemory = SqlitePersistence.layerMemory,
) =>
  Layer.mergeAll(
    RuntimeLayer.layer,
    RuntimeLayer.layerEventSink,
    ProjectionStore.layer,
    EventStore.layerFromOrchestrationEventStore.pipe(
      Layer.provide(RuntimeLayer.layerEventInfrastructure),
    ),
  ).pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provide(
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
    ),
    Layer.provide(ProviderTurnStartServiceTestkit.layer),
    Layer.provide(
      Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
        peek: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        request: () => Effect.void,
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
        invalidate: () => Effect.void,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(persistence),
    Layer.provide(layerCheckpointStoreTest),
    Layer.provide(layerServerConfig),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerTestProviderInstanceRegistry),
    Layer.provide(layerPlatformTest),
  );

const layerTest = makeLayerTest();

const seedParentWithTerminalTask = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly taskId: NodeId;
  readonly deliveryState: "delivered" | "claimed" | "acknowledged" | "disposed";
  readonly completionWake?: "always" | "settled_only";
  readonly deliveryTaskIds?: ReadonlyArray<NodeId>;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const providerThreadId = ProviderThreadId.make(
      `provider-thread:${String(input.threadId).replace("thread:", "")}`,
    );

    yield* projects.create({
      commandId: CommandId.make(`command:seed-project:${input.threadId}`),
      projectId: input.projectId,
      title: "Delegated completion delivery",
      workspaceRoot: `/workspace/${input.projectId}`,
    });

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:seed-create:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Delegated completion delivery",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-projection:${input.threadId}`),
      events: [
        {
          id: EventId.make(`event:seed-provider-thread:${input.threadId}`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: input.rootNodeId,
            nativeThreadRef: {
              driver,
              nativeId: `native:${input.threadId}`,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: input.now,
            updatedAt: input.now,
          },
        },
        {
          id: EventId.make(`event:seed-run:${input.threadId}`),
          type: "run.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:seed-user:${input.threadId}`),
            rootNodeId: input.rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: input.now,
            startedAt: input.now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 2,
              delivery:
                input.deliveryTaskIds === undefined
                  ? null
                  : {
                      generation: 1,
                      messageId: MessageId.make(`message:delegated-delivery:${input.threadId}`),
                      taskIds: input.deliveryTaskIds,
                    },
            },
          },
        },
        {
          id: EventId.make(`event:seed-task:${input.threadId}`),
          type: "subagent.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.taskId,
            threadId: input.threadId,
            runId: input.runId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Inspect the delivered ownership edge.",
            title: null,
            model: null,
            completionWake: input.completionWake ?? "settled_only",
            completionDelivery: {
              state: input.deliveryState,
              observedByRunId: input.deliveryState === "acknowledged" ? input.runId : null,
            },
            status: "completed",
            result: "child finished",
            startedAt: input.now,
            completedAt: input.now,
            updatedAt: input.now,
          },
        },
      ],
    });
  });

it.layer(layerTest)("delegated completion delivery repairs", (it) => {
  it.effect("acceptance batches pending siblings without acknowledging their results", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("mailbox-batch");
      const runId = RunId.make("mailbox-parent");
      const taskId = NodeId.make("mailbox-first");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("mailbox-project"),
        rootNodeId: NodeId.make("mailbox-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents[0]!;
      const pendingIds = [NodeId.make("mailbox-second"), NodeId.make("mailbox-third")];
      yield* sink.write({
        events: [
          {
            id: EventId.make("mailbox-message"),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId,
              nodeId: task.parentNodeId,
              role: "user",
              text: "Background task finished",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
          ...pendingIds.map((id) => ({
            id: EventId.make(`event:${id}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: id,
            occurredAt: now,
            payload: {
              ...task,
              id,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
            },
          })),
        ],
      });
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("accept-first"),
        threadId,
        messageId,
      });
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        accepted.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
        "delivered",
      );
      const cohort = accepted.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.deepEqual(cohort?.delivery?.taskIds, pendingIds);
      assert.equal(cohort?.delivery?.generation, 2);
      for (const id of pendingIds) {
        assert.deepEqual(accepted.subagents.find((row) => row.id === id)?.completionDelivery, {
          state: "claimed",
          generation: 2,
          observedByRunId: null,
        });
      }
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("repeat-old-acceptance"),
        threadId,
        messageId,
      });
      const duplicate = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(duplicate.runs.find((row) => row.id === runId)?.delegatedCompletion, cohort);
    }),
  );

  it.effect("acceptance batches a settled_only sibling once its spawning run ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("mailbox-mixed");
      const runId = RunId.make("mailbox-mixed-parent");
      const taskId = NodeId.make("mailbox-mixed-always");
      const siblingId = NodeId.make("mailbox-mixed-settled-only");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("mailbox-mixed-project"),
        rootNodeId: NodeId.make("mailbox-mixed-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents[0]!;
      const spawningRun = projection.runs.find((row) => row.id === runId)!;
      // A restart cut the spawning run; its continuation is the live run now.
      yield* sink.write({
        events: [
          {
            ...runEvent({ threadId, runId, ordinal: 1, status: "cancelled", now }),
            payload: { ...spawningRun, status: "cancelled" as const, completedAt: now },
          },
          runEvent({
            threadId,
            runId: RunId.make("mailbox-mixed-continuation"),
            ordinal: 2,
            status: "running",
            now,
          }),
          {
            id: EventId.make("mailbox-mixed-message"),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId,
              nodeId: task.parentNodeId,
              role: "user",
              text: "Background task finished",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
          {
            id: EventId.make(`event:${siblingId}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: siblingId,
            occurredAt: now,
            payload: {
              ...task,
              id: siblingId,
              completionWake: "settled_only" as const,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("accept-mixed"),
        threadId,
        messageId,
      });
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      const cohort = accepted.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.deepEqual(cohort?.delivery?.taskIds, [siblingId]);
      assert.equal(
        accepted.subagents.find((row) => row.id === siblingId)?.completionDelivery?.state,
        "claimed",
      );
    }),
  );

  it.effect("builds completion text and metadata from the same live cohort", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delegated-delivery-live-cohort");
      const projectId = ProjectId.make("project:delegated-delivery-live-cohort");
      const runId = RunId.make("run:delegated-delivery-live-cohort");
      const rootNodeId = NodeId.make("node:delegated-delivery-live-cohort-root");
      const firstTaskId = NodeId.make("node:delegated-delivery-live-cohort-first");
      const secondTaskId = NodeId.make("node:delegated-delivery-live-cohort-second");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);

      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: firstTaskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [firstTaskId, secondTaskId],
        now,
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:delegated-delivery-live-cohort"),
        threadId,
        messageId,
        text: `Delegated task ${firstTaskId} reached a terminal state.`,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: {
          parentRunId: runId,
          generation: 1,
          taskIds: [firstTaskId],
        },
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const message = projection.messages.find((candidate) => candidate.id === messageId);
      assert.deepEqual(message?.delegatedCompletion?.taskIds, [firstTaskId, secondTaskId]);
      assert.include(message?.text ?? "", String(firstTaskId));
      assert.include(message?.text ?? "", String(secondTaskId));
      assert.include(message?.text ?? "", "task_status");
    }),
  );

  it.effect("does not re-offer when wake-policy upgrades after delivered ownership settled", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delegated-delivery-a1");
      const projectId = ProjectId.make("project:delegated-delivery-a1");
      const runId = RunId.make("run:delegated-delivery-a1");
      const rootNodeId = NodeId.make("node:delegated-delivery-a1-root");
      const taskId = NodeId.make("node:delegated-delivery-a1-task");

      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId,
        deliveryState: "delivered",
        completionWake: "settled_only",
        now,
      });

      const upgrade = yield* orchestrator.dispatch({
        type: "delegated_task.wake-policy",
        commandId: CommandId.make("command:delegated-delivery-a1:wake-policy"),
        parentThreadId: threadId,
        taskId,
        completionWake: "always",
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents.find((candidate) => candidate.id === taskId);
      const parentRun = projection.runs.find((candidate) => candidate.id === runId);

      assert.equal(task?.completionWake, "always");
      assert.deepEqual(task?.completionDelivery, {
        state: "delivered",
        observedByRunId: null,
      });
      assert.deepEqual(parentRun?.delegatedCompletion, {
        disposition: "open",
        nextGeneration: 2,
        delivery: null,
      });
      assert.isFalse(
        upgrade.storedEvents.some(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === taskId &&
            stored.event.payload.completionDelivery?.state === "claimed",
        ),
      );
      assert.isFalse(
        upgrade.storedEvents.some(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === runId &&
            stored.event.payload.delegatedCompletion?.delivery !== null &&
            stored.event.payload.delegatedCompletion?.delivery !== undefined,
        ),
      );
    }),
  );

  it.effect(
    "treats repeated acknowledge and dispose with distinct command IDs as successful no-ops",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:delegated-delivery-a2");
        const projectId = ProjectId.make("project:delegated-delivery-a2");
        const runId = RunId.make("run:delegated-delivery-a2");
        const rootNodeId = NodeId.make("node:delegated-delivery-a2-root");
        const taskId = NodeId.make("node:delegated-delivery-a2-task");

        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId,
          deliveryState: "delivered",
          completionWake: "always",
          now,
        });

        // Distinct command IDs mirror task_status vs t3_thread_read racing after
        // their shared read preflight saw delivered ownership.
        const firstAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-task-status"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const secondAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-thread-read"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });

        const firstAckTask = firstAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondAckTask = secondAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstAckTask);
        assert.isDefined(secondAckTask);
        if (
          firstAckTask?.event.type !== "subagent.updated" ||
          secondAckTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Acknowledge events missing."));
        }
        assert.equal(firstAckTask.event.payload.completionDelivery?.state, "acknowledged");
        assert.equal(secondAckTask.event.payload.completionDelivery?.state, "acknowledged");
        // Idempotent replay keeps the first observation's ownership and timestamp.
        assert.deepEqual(
          secondAckTask.event.payload.completionDelivery,
          firstAckTask.event.payload.completionDelivery,
        );
        assert.deepEqual(
          secondAckTask.event.payload.updatedAt,
          firstAckTask.event.payload.updatedAt,
        );
        assert.equal(secondAck.storedEvents.length, 1);

        const afterAck = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterAck.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "acknowledged",
            observedByRunId: runId,
          },
        );

        const firstDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-task-status"),
          parentThreadId: threadId,
          taskId,
        });
        const secondDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-thread-read"),
          parentThreadId: threadId,
          taskId,
        });

        const firstDisposeTask = firstDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondDisposeTask = secondDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstDisposeTask);
        assert.isDefined(secondDisposeTask);
        if (
          firstDisposeTask?.event.type !== "subagent.updated" ||
          secondDisposeTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Dispose events missing."));
        }
        assert.equal(firstDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.equal(secondDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.deepEqual(
          secondDisposeTask.event.payload.completionDelivery,
          firstDisposeTask.event.payload.completionDelivery,
        );
        assert.equal(secondDispose.storedEvents.length, 1);

        const afterDispose = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterDispose.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );

        const acknowledgeAfterDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-after-dispose"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const acknowledgedTask = acknowledgeAfterDispose.storedEvents.find(
          (stored) => stored.event.type === "subagent.updated",
        );
        if (acknowledgedTask?.event.type !== "subagent.updated") {
          return yield* Effect.die(new Error("Acknowledge-after-dispose event missing."));
        }
        assert.deepEqual(acknowledgedTask.event.payload.completionDelivery, {
          state: "disposed",
          observedByRunId: null,
        });
        assert.equal(acknowledgeAfterDispose.storedEvents.length, 1);

        const afterStaleAcknowledge = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterStaleAcknowledge.subagents.find((candidate) => candidate.id === taskId)
            ?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );
      }),
  );
});

// Runtime reconciliation writes restart cancellations under this command
// prefix, which the live terminal-run listener skips.
const reconcileCommandId = (name: string) => CommandId.make(`command:runtime-reconcile:${name}`);

const parentProviderThreadId = (threadId: ThreadId) =>
  ProviderThreadId.make(`provider-thread:${String(threadId).replace("thread:", "")}`);

const runEvent = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
  readonly providerThreadId?: ProviderThreadId;
  readonly userMessageId?: MessageId;
  readonly delegatedCompletion?: OrchestrationV2Run["delegatedCompletion"];
  readonly delegatedTaskId?: NodeId;
}) => ({
  id: EventId.make(`event:${input.runId}:${input.status}`),
  type: "run.updated" as const,
  threadId: input.threadId,
  runId: input.runId,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: input.now,
  payload: {
    id: input.runId,
    threadId: input.threadId,
    ordinal: input.ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: input.providerThreadId ?? null,
    userMessageId: input.userMessageId ?? MessageId.make(`message:${input.runId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: input.status,
    requestedAt: input.now,
    startedAt: input.now,
    completedAt: input.status === "running" ? null : input.now,
    checkpointId: null,
    contextHandoffId: null,
    ...(input.delegatedTaskId === undefined ? {} : { delegatedTaskId: input.delegatedTaskId }),
    ...(input.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: input.delegatedCompletion }),
  },
});

/** A running app-owned task whose child thread's first run the restart cancelled. */
const seedRestartCancelledChild = (input: {
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentRunId: RunId;
  readonly rootNodeId: NodeId;
  readonly name: string;
  readonly completionWake: "always" | "settled_only";
  readonly continuationPending: boolean;
  /** "completed" seeds a settled turn whose background work the restart cancelled. */
  readonly runStatus?: "cancelled" | "completed";
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const taskId = NodeId.make(`node:${input.name}`);
    const childThreadId = ThreadId.make(`thread:${input.name}`);
    const childRunId = RunId.make(`run:${input.name}:1`);
    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-child:${input.name}`),
      events: [
        {
          id: EventId.make(`event:${input.name}:thread`),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: input.now,
          payload: {
            createdBy: "agent",
            creationSource: "server",
            id: childThreadId,
            projectId: input.projectId,
            title: input.name,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: input.parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: input.parentThreadId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
            createdAt: input.now,
            updatedAt: input.now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        {
          id: EventId.make(`event:${input.name}:task`),
          type: "subagent.updated",
          threadId: input.parentThreadId,
          runId: input.parentRunId,
          nodeId: taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: taskId,
            threadId: input.parentThreadId,
            runId: input.parentRunId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: `Run ${input.name}.`,
            title: null,
            model: null,
            completionWake: input.completionWake,
            status: "running",
            result: null,
            startedAt: input.now,
            completedAt: null,
            updatedAt: input.now,
          },
        },
      ],
    });
    yield* eventSink.writeWithEffects({
      commandId: reconcileCommandId(input.name),
      events: [
        runEvent({
          threadId: childThreadId,
          runId: childRunId,
          ordinal: 1,
          status: input.runStatus ?? "cancelled",
          now: input.now,
        }),
      ],
      effects: input.continuationPending
        ? [
            {
              id: `effect:restart-continuation:${childRunId}`,
              commandId: reconcileCommandId(input.name),
              threadId: childThreadId,
              request: { type: "provider-runtime.continue", sourceRunId: childRunId },
            },
          ]
        : [],
    });
    return { taskId, childThreadId, childRunId };
  });

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "subagent follow-ups",
  (it) => {
    const outcomes = [
      "completed",
      "failed",
      "interrupted",
      "restarted",
      "stopped",
      "overlapping",
    ] as const;
    it.effect.each(outcomes)(
      "delivers a %s follow-up independently of the original task",
      (outcome) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const parentThreadId = ThreadId.make(`thread:followup-${outcome}`);
          const projectId = ProjectId.make(`project:followup-${outcome}`);
          const parentRunId = RunId.make(`run:followup-${outcome}`);
          const rootNodeId = NodeId.make(`node:followup-${outcome}`);
          yield* seedParentWithTerminalTask({
            threadId: parentThreadId,
            projectId,
            runId: parentRunId,
            rootNodeId,
            taskId: NodeId.make(`node:seed-${outcome}`),
            deliveryState: "acknowledged",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId,
            projectId,
            parentRunId,
            rootNodeId,
            name: `followup-child-${outcome}`,
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          yield* orchestrator.recoverDelegatedTasks;
          let firstWake = yield* requests.take;
          while (firstWake.threadId !== parentThreadId) firstWake = yield* requests.take;
          assert.equal(firstWake.delegatedCompletion?.parentRunId, parentRunId);
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make(`command:followup-ack-${outcome}`),
            parentThreadId,
            taskId: child.taskId,
            resultRunId: child.childRunId,
            observedByRunId: parentRunId,
          });
          const original = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === child.taskId,
          )!;
          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
            (run) => run.id === parentRunId,
          )!;
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-parent-finished-${outcome}`),
            events: [
              {
                id: EventId.make(`event:followup-parent-finished-${outcome}`),
                type: "run.updated",
                threadId: parentThreadId,
                runId: parentRunId,
                occurredAt: now,
                payload: { ...parentRun, status: "completed", completedAt: now },
              },
            ],
          });
          const messageId = MessageId.make(`message:followup-${outcome}`);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: outcome === "failed" ? "user" : "agent",
            creationSource: outcome === "failed" ? "web" : "mcp",
            commandId: CommandId.make(`command:followup-send-${outcome}`),
            threadId: child.childThreadId,
            senderThreadId: parentThreadId,
            messageId,
            text: "Check the same work again.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
          let run = childProjection.runs.find((row) => row.userMessageId === messageId)!;
          assert.isDefined(run.delegatedTaskId);
          const workingParent = yield* orchestrator.getShellSnapshot();
          const backgroundTask = workingParent.threads
            .find((thread) => thread.id === parentThreadId)
            ?.pendingBackgroundTasks?.find((task) => task.kind === "subagent");
          assert.equal(backgroundTask?.childThreadId, child.childThreadId);
          if (outcome === "overlapping") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:overlapping-followup"),
              threadId: child.childThreadId,
              senderThreadId: parentThreadId,
              messageId: MessageId.make("message:overlapping-followup"),
              text: "Keep working on another follow-up.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
            });
          }
          if (outcome === "restarted") {
            const cut = { ...run, status: "cancelled" as const, startedAt: now, completedAt: now };
            yield* eventSink.writeWithEffects({
              commandId: reconcileCommandId("followup-restart-cut"),
              events: [
                {
                  id: EventId.make("event:followup-restart-cut"),
                  type: "run.updated",
                  threadId: child.childThreadId,
                  runId: run.id,
                  occurredAt: now,
                  payload: cut,
                },
              ],
              effects: [
                {
                  id: `effect:restart-continuation:${run.id}`,
                  commandId: reconcileCommandId("followup-restart-cut"),
                  threadId: child.childThreadId,
                  request: { type: "provider-runtime.continue", sourceRunId: run.id },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
            assert.isNull(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === run.delegatedTaskId,
              )!.result,
            );
            const continuationMessageId = MessageId.make("message:followup-restart-continuation");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:followup-restart-continuation"),
              threadId: child.childThreadId,
              restartContinuationOfRunId: run.id,
              messageId: continuationMessageId,
              text: "Continue where you left off.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            });
            const continuation = (yield* orchestrator.getThreadProjection(
              child.childThreadId,
            )).runs.find((row) => row.userMessageId === continuationMessageId)!;
            assert.equal(continuation.delegatedTaskId, run.delegatedTaskId);
            run = continuation;
          }
          if (outcome === "stopped") {
            yield* orchestrator.dispatch({
              type: "thread.stop",
              threadId: parentThreadId,
              commandId: CommandId.make(`command:followup-stop-${outcome}`),
            });
          }
          // Reconciliation skips the live terminal listener; recovery must finish this recorded task.
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-finish-${outcome}`),
            events: [
              {
                id: EventId.make(`event:followup-finish-${outcome}`),
                type: "run.updated",
                threadId: child.childThreadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...run,
                  status:
                    outcome === "stopped"
                      ? "interrupted"
                      : outcome === "restarted" || outcome === "overlapping"
                        ? "completed"
                        : outcome,
                  startedAt: now,
                  completedAt: now,
                },
              },
            ],
          });
          yield* orchestrator.recoverDelegatedTasks;
          const finished = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.deepEqual(
            finished.subagents.find((task) => task.id === child.taskId),
            original,
          );
          const followup = finished.subagents.find((task) => task.id === run.delegatedTaskId)!;
          if (outcome === "overlapping") {
            const later = finished.subagents.find(
              (task) =>
                task.childThreadId === child.childThreadId &&
                task.id !== child.taskId &&
                task.id !== followup.id,
            )!;
            assert.equal(later.status, "pending");
            assert.isNull(later.result);
          }
          assert.equal(
            followup.status,
            outcome === "stopped"
              ? "interrupted"
              : outcome === "restarted" || outcome === "overlapping"
                ? "completed"
                : outcome,
          );
          assert.equal(
            followup.completionDelivery?.state,
            outcome === "stopped" ? "disposed" : "claimed",
          );
          if (outcome !== "stopped") {
            let wake = yield* requests.take;
            while (
              wake.threadId !== parentThreadId ||
              wake.delegatedCompletion?.messageId === firstWake.delegatedCompletion?.messageId
            ) {
              wake = yield* requests.take;
            }
            assert.equal(wake.delegatedCompletion?.parentRunId, parentRunId);
            assert.notEqual(
              wake.delegatedCompletion?.messageId,
              firstWake.delegatedCompletion?.messageId,
            );
          }
          assert.equal(
            finished.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === child.childThreadId,
            ).length,
            2,
          );
          yield* orchestrator.recoverDelegatedTasks;
          const recovered = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.equal(recovered.contextTransfers.length, finished.contextTransfers.length);
          if (outcome === "completed") {
            const automaticMessageId = MessageId.make("message:followup-automatic-wake");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:followup-automatic-wake"),
              threadId: child.childThreadId,
              messageId: automaticMessageId,
              text: "A monitor reported new output.",
              attachments: [],
              notification: {
                source: { kind: "monitor" },
                outcome: "updated",
                summary: "Monitor updated",
              },
              dispatchMode: { type: "queue_after_active" },
            });
            const automatic = (yield* orchestrator.getThreadProjection(
              child.childThreadId,
            )).runs.find((run) => run.userMessageId === automaticMessageId)!;
            assert.isUndefined(automatic.delegatedTaskId);
            yield* eventSink.write({
              commandId: reconcileCommandId("followup-automatic-finished"),
              events: [
                {
                  id: EventId.make("event:followup-automatic-finished"),
                  type: "run.updated",
                  threadId: child.childThreadId,
                  runId: automatic.id,
                  occurredAt: now,
                  payload: { ...automatic, status: "completed", startedAt: now, completedAt: now },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
            const afterAutomatic = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.deepEqual(afterAutomatic.subagents, recovered.subagents);
            assert.equal(afterAutomatic.contextTransfers.length, recovered.contextTransfers.length);
            const control = yield* seedRestartCancelledChild({
              parentThreadId,
              projectId,
              parentRunId,
              rootNodeId,
              name: "followup-control-child",
              completionWake: "always",
              continuationPending: false,
              runStatus: "completed",
              now,
            });
            yield* orchestrator.recoverDelegatedTasks;
            const afterControl = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.equal(
              afterControl.subagents.find((task) => task.id === control.taskId)?.completionDelivery
                ?.state,
              "claimed",
            );
            assert.equal(
              afterControl.contextTransfers.filter(
                (transfer) =>
                  transfer.type === "subagent_result" &&
                  transfer.sourceThreadId === control.childThreadId,
              ).length,
              1,
            );
          }
        }),
    );
  },
);

it.layer(layerTest)("delegated tasks across a server restart", (it) => {
  it.effect("holds a restart-cancelled child for its continuation's result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-parent");
      const projectId = ProjectId.make("project:restart-parent");
      const runId = RunId.make("run:restart-parent");
      const rootNodeId = NodeId.make("node:restart-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = (
        name: string,
        continuationPending: boolean,
        runStatus?: "cancelled" | "completed",
      ) =>
        seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name,
          completionWake: "always",
          continuationPending,
          ...(runStatus === undefined ? {} : { runStatus }),
          now,
        });
      const resumed = yield* child("restart-resumed-child", true);
      const stopped = yield* child("restart-stopped-child", false);
      // Settled with only background work left: its interim reply is not the result.
      const backgrounded = yield* child("restart-backgrounded-child", true, "completed");
      // A second restart cut the first continuation before it started.
      const recut = yield* child("restart-recut-child", false);
      const recutContinuationId = RunId.make("run:restart-recut-child:2");
      const recutCommandId = CommandId.make("command:restart-recut-child:reconcile");
      const recutRun = runEvent({
        threadId: recut.childThreadId,
        runId: recutContinuationId,
        ordinal: 2,
        status: "cancelled",
        now,
      });
      yield* eventSink.writeWithEffects({
        commandId: recutCommandId,
        events: [
          {
            ...recutRun,
            payload: {
              ...recutRun.payload,
              startedAt: null,
              restartContinuationOfRunId: recut.childRunId,
            },
          },
        ],
        effects: [
          {
            id: `effect:restart-continuation:${recutContinuationId}`,
            commandId: recutCommandId,
            threadId: recut.childThreadId,
            request: { type: "provider-runtime.continue", sourceRunId: recutContinuationId },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = (id: NodeId) => recovered.subagents.find((row) => row.id === id);
      assert.equal(task(stopped.taskId)?.status, "cancelled");
      assert.equal(task(stopped.taskId)?.completionDelivery?.state, "claimed");
      assert.equal(task(resumed.taskId)?.status, "running");
      assert.isNull(task(resumed.taskId)?.result ?? null);
      assert.equal(task(backgrounded.taskId)?.status, "running");
      assert.isNull(task(backgrounded.taskId)?.result ?? null);
      assert.equal(task(recut.taskId)?.status, "running");
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(recut.childThreadId));
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(resumed.childThreadId));
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(stopped.childThreadId));
      // A replayed first continuation settling must not release the second one's hold.
      yield* orchestrator.recoverDelegatedTask(recut.childThreadId, recut.childRunId);
      const replayed = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(replayed.subagents.find((row) => row.id === recut.taskId)?.status, "running");
      // A caller that read the cancelled run before the child resumed sees it as pending.
      yield* eventSink.write({
        commandId: CommandId.make("command:restart-stopped-child:resumed"),
        events: [
          runEvent({
            threadId: stopped.childThreadId,
            runId: RunId.make("run:restart-stopped-child:2"),
            ordinal: 2,
            status: "running",
            now,
          }),
        ],
      });
      assert.isTrue(yield* orchestrator.delegatedTaskResultPending(stopped.childThreadId));
      assert.isFalse(
        recovered.contextTransfers.some(
          (transfer) => transfer.sourceThreadId === resumed.childThreadId,
        ),
      );

      // The continuation's own run finishing settles the task with its result.
      const afterSequence = yield* eventSink.latestSequence();
      const continuationRunId = RunId.make("run:restart-resumed-child:2");
      yield* eventSink.write({
        commandId: CommandId.make("command:restart-resumed-child:completed"),
        events: [
          {
            id: EventId.make("event:restart-resumed-child:result"),
            type: "message.updated",
            threadId: resumed.childThreadId,
            runId: continuationRunId,
            occurredAt: now,
            payload: {
              id: MessageId.make("message:restart-resumed-child:result"),
              threadId: resumed.childThreadId,
              runId: continuationRunId,
              nodeId: null,
              role: "assistant",
              text: "Finished after the restart.",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
            },
          },
          runEvent({
            threadId: resumed.childThreadId,
            runId: continuationRunId,
            ordinal: 2,
            status: "completed",
            now,
          }),
        ],
      });
      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === resumed.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const finished = yield* orchestrator.getThreadProjection(threadId);
      const finishedTask = finished.subagents.find((row) => row.id === resumed.taskId);
      assert.equal(finishedTask?.status, "completed");
      assert.equal(finishedTask?.result, "Finished after the restart.");
    }),
  );

  it.effect("settles a restart-cancelled child whose continuation declines to start", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-declined-parent");
      const projectId = ProjectId.make("project:restart-declined-parent");
      const runId = RunId.make("run:restart-declined-parent");
      const rootNodeId = NodeId.make("node:restart-declined-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:restart-declined-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "restart-declined-child",
        completionWake: "always",
        continuationPending: true,
        now,
      });
      yield* orchestrator.recoverDelegatedTasks;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.subagents.find((row) => row.id === child.taskId)?.status, "running");

      yield* continueRestartedRun({
        threadId: child.childThreadId,
        sourceRunId: child.childRunId,
      }).pipe(
        Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
      );

      const settled = yield* orchestrator.getThreadProjection(threadId);
      const task = settled.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.equal(task?.completionDelivery?.state, "claimed");
    }),
  );

  // A running provider turn does not prove the provider consumed the delivery
  // (Claude marks the turn running before it reads the prompt), so a cut
  // delivery is offered again even when a continuation resumes that turn.
  it.effect("re-offers a cut delivery even when a continuation resumes its turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const seed = (name: string, continuationPending: boolean) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(`thread:${name}`);
          const runId = RunId.make(`run:${name}`);
          const taskId = NodeId.make(`node:${name}-task`);
          const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
          const deliveryRunId = RunId.make(`run:${name}:delivery`);
          yield* seedParentWithTerminalTask({
            threadId,
            projectId: ProjectId.make(`project:${name}`),
            runId,
            rootNodeId: NodeId.make(`node:${name}-root`),
            taskId,
            deliveryState: "claimed",
            completionWake: "always",
            deliveryTaskIds: [taskId],
            now,
          });
          yield* eventSink.writeWithEffects({
            commandId: reconcileCommandId(name),
            events: [
              {
                id: EventId.make(`event:${name}:delivery-message`),
                type: "message.updated",
                threadId,
                runId: deliveryRunId,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId,
                  runId: deliveryRunId,
                  nodeId: null,
                  role: "user",
                  text: `Delegated task ${taskId} reached a terminal state.`,
                  attachments: [],
                  streaming: false,
                  createdBy: "agent",
                  creationSource: "server",
                  createdAt: now,
                  updatedAt: now,
                  delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
                },
              },
              runEvent({
                threadId,
                runId: deliveryRunId,
                ordinal: 2,
                status: "cancelled",
                now,
                providerThreadId: parentProviderThreadId(threadId),
                userMessageId: messageId,
              }),
            ],
            effects: continuationPending
              ? [
                  {
                    id: `effect:restart-continuation:${deliveryRunId}`,
                    commandId: reconcileCommandId(name),
                    threadId,
                    request: { type: "provider-runtime.continue", sourceRunId: deliveryRunId },
                  },
                ]
              : [],
          });
          return { threadId, runId, taskId };
        });
      const cut = yield* seed("delivery-cut", false);
      const resumed = yield* seed("delivery-resumed", true);

      yield* orchestrator.recoverDelegatedTasks;

      for (const seeded of [cut, resumed]) {
        const projection = yield* orchestrator.getThreadProjection(seeded.threadId);
        assert.deepEqual(
          projection.subagents.find((row) => row.id === seeded.taskId)?.completionDelivery?.state,
          "claimed",
        );
        const delivery = projection.runs.find((row) => row.id === seeded.runId)?.delegatedCompletion
          ?.delivery;
        assert.equal(delivery?.generation, 2);
        assert.deepEqual(delivery?.taskIds, [seeded.taskId]);
      }
    }),
  );

  it.effect("settles a cancelled child whose held wakes wait behind it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:held-wake-parent");
      const projectId = ProjectId.make("project:held-wake-parent");
      const runId = RunId.make("run:held-wake-parent");
      const rootNodeId = NodeId.make("node:held-wake-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:held-wake-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "held-wake-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      // Pull request watch wakes queued while the child ran; the restart held them.
      const held = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:held-wake-child:2"),
        ordinal: 2,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:held-wake-child:held"),
        events: [
          {
            ...held,
            payload: { ...held.payload, startedAt: null, completedAt: null, queueHeld: true },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = recovered.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.isNotNull(task?.result ?? null);
      assert.isTrue(
        recovered.contextTransfers.some(
          (transfer) =>
            transfer.type === "subagent_result" && transfer.sourceThreadId === child.childThreadId,
        ),
      );
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(child.childThreadId));
      // The held wake stays held for the user to resume or discard.
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["queued", true],
        ],
      );
    }),
  );

  it.effect("settles a child whose provider failure holds its queued wakes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:failed-hold-parent");
      const projectId = ProjectId.make("project:failed-hold-parent");
      const runId = RunId.make("run:failed-hold-parent");
      const rootNodeId = NodeId.make("node:failed-hold-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:failed-hold-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "failed-hold-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      // The child is resumed, and a wake queues behind its running turn.
      const activeRun = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:2"),
        ordinal: 2,
        status: "running",
        now,
      });
      const queued = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:3"),
        ordinal: 3,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:resumed"),
        events: [
          activeRun,
          { ...queued, payload: { ...queued.payload, startedAt: null, completedAt: null } },
        ],
      });
      const afterSequence = yield* eventSink.latestSequence();
      const errorItemId = TurnItemId.make("turn-item:failed-hold-child:error");
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:failed"),
        events: [
          {
            id: EventId.make("event:failed-hold-child:error"),
            type: "turn-item.updated",
            threadId: child.childThreadId,
            runId: activeRun.runId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: errorItemId,
              type: "error",
              threadId: child.childThreadId,
              runId: activeRun.runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "failed",
              title: "Provider failure",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "provider_error",
                message: "Provider failed.",
                code: "provider_failed",
                retryable: null,
              },
            },
          },
          {
            ...activeRun,
            id: EventId.make("event:failed-hold-child:failed"),
            payload: { ...activeRun.payload, status: "failed", completedAt: now },
          },
        ],
      });

      // The failure holds the queue, which leaves the failure as the task's result.
      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" && stored.event.payload.id === child.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const recovered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(recovered.subagents.find((row) => row.id === child.taskId)?.status, "failed");
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["failed", false],
          ["queued", true],
        ],
      );
    }),
  );

  it.effect("wakes the parent for a settled_only task once its spawning turn ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:settled-only-restart");
      const projectId = ProjectId.make("project:settled-only-restart");
      const runId = RunId.make("run:settled-only-restart");
      const rootNodeId = NodeId.make("node:settled-only-restart-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:settled-only-restart-settled"),
        deliveryState: "delivered",
        now,
      });
      // The restart cut the turn blocked in delegate_task(wait); its
      // continuation is a new, live run.
      yield* eventSink.write({
        commandId: reconcileCommandId("settled-only-restart"),
        events: [
          runEvent({
            threadId,
            runId,
            ordinal: 1,
            status: "cancelled",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: MessageId.make(`message:seed-user:${threadId}`),
            delegatedCompletion: { disposition: "open", nextGeneration: 2, delivery: null },
          }),
          runEvent({
            threadId,
            runId: RunId.make("run:settled-only-restart:continuation"),
            ordinal: 2,
            status: "running",
            now,
            providerThreadId: parentProviderThreadId(threadId),
          }),
        ],
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "settled-only-restart-child",
        completionWake: "settled_only",
        continuationPending: false,
        now,
      });

      yield* orchestrator.recoverDelegatedTasks;

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.subagents.find((row) => row.id === child.taskId)?.completionDelivery?.state,
        "claimed",
      );
      assert.deepEqual(
        projection.runs.find((row) => row.id === runId)?.delegatedCompletion?.delivery?.taskIds,
        [child.taskId],
      );
    }),
  );
});

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "same-task later terminal results",
  (it) => {
    it.effect.each([
      "idle",
      "active",
      "disposed",
      "independent-followup",
      "refusal-race",
      "held-pending",
      "held-running",
    ])("delivers a later result to an %s parent after acknowledgment of failure", (parentState) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const eventStore = yield* EventStore.EventStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`thread:later-result-${parentState}`);
        const projectId = ProjectId.make(`project:later-result-${parentState}`);
        const parentRunId = RunId.make(`run:later-result-${parentState}`);
        const rootNodeId = NodeId.make(`node:later-result-${parentState}`);
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make(`node:later-result-seed-${parentState}`),
          deliveryState: "delivered",
          now,
        });
        if (parentState === "idle") {
          const parent = yield* orchestrator.getThreadProjection(threadId);
          const run = parent.runs.find((row) => row.id === parentRunId);
          if (run === undefined) return yield* Effect.die("Missing seeded parent run");
          yield* eventSink.write({
            commandId: reconcileCommandId(`later-parent-${parentState}`),
            events: [
              {
                id: EventId.make(`event:later-parent-${parentState}`),
                type: "run.updated",
                threadId,
                runId: parentRunId,
                occurredAt: now,
                payload: { ...run, status: "completed", completedAt: now },
              },
            ],
          });
        }
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: `later-result-child-${parentState}`,
          completionWake: "always",
          continuationPending: false,
          now,
        });
        const terminal = (
          runId: RunId,
          ordinal: number,
          status: "failed" | "completed",
          text: string,
        ) =>
          eventSink.writeWithEffects({
            commandId: reconcileCommandId(`later-terminal-${parentState}-${ordinal}`),
            effects:
              ordinal === 2 && (parentState === "held-pending" || parentState === "held-running")
                ? [
                    {
                      id: `effect:restart-continuation:${runId}`,
                      commandId: reconcileCommandId(`later-terminal-${parentState}-${ordinal}`),
                      threadId: child.childThreadId,
                      request: { type: "provider-runtime.continue", sourceRunId: runId },
                    },
                  ]
                : [],
            events: [
              {
                id: EventId.make(`event:later-message-${parentState}-${ordinal}`),
                type: "message.updated",
                threadId: child.childThreadId,
                runId,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`message:later-result-${parentState}-${ordinal}`),
                  threadId: child.childThreadId,
                  runId,
                  nodeId: null,
                  role: "assistant",
                  text,
                  attachments: [],
                  streaming: false,
                  createdBy: "agent",
                  creationSource: "server",
                  createdAt: now,
                  updatedAt: now,
                },
              },
              runEvent({
                threadId: child.childThreadId,
                runId,
                ordinal,
                status,
                now,
                delegatedTaskId: child.taskId,
              }),
            ],
          });
        yield* terminal(child.childRunId, 1, "failed", "Original usage-limit failure.");
        yield* orchestrator.recoverDelegatedTasks;
        const original = yield* orchestrator.getThreadProjection(threadId);
        const firstTransfer = original.contextTransfers.find(
          (row) => row.type === "subagent_result" && row.sourceThreadId === child.childThreadId,
        );
        assert.equal(firstTransfer?.sourcePoint.runId, child.childRunId);
        let firstWake = yield* requests.take.pipe(Effect.timeout("3 seconds"));
        while (
          firstWake.threadId !== threadId ||
          firstWake.delegatedCompletion?.generation !==
            original.runs.find((row) => row.id === parentRunId)?.delegatedCompletion?.delivery
              ?.generation
        ) {
          firstWake = yield* requests.take.pipe(Effect.timeout("3 seconds"));
        }
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make(`command:later-first-ack-${parentState}`),
          parentThreadId: threadId,
          taskId: child.taskId,
          observedByRunId: parentRunId,
          resultRunId: child.childRunId,
        });
        const acknowledgedFailure = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          acknowledgedFailure.subagents.find((row) => row.id === child.taskId)?.completionDelivery
            ?.state,
          "acknowledged",
        );
        if (parentState === "disposed") {
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.dispose",
            commandId: CommandId.make("command:later-task-dispose"),
            parentThreadId: threadId,
            taskId: child.taskId,
          });
        }
        const followupTaskId = NodeId.make(`node:independent-followup-${parentState}`);
        const followupRunId = RunId.make(`run:independent-followup-${parentState}`);
        if (
          parentState === "independent-followup" ||
          parentState === "held-pending" ||
          parentState === "held-running"
        ) {
          const originalTask = acknowledgedFailure.subagents.find((row) => row.id === child.taskId);
          if (originalTask === undefined)
            return yield* Effect.die("Missing published original task");
          yield* eventSink.write({
            commandId: reconcileCommandId(`independent-followup-running-${parentState}`),
            events: [
              {
                id: EventId.make(`event:independent-followup-task-${parentState}`),
                type: "subagent.updated",
                threadId,
                nodeId: followupTaskId,
                occurredAt: now,
                payload: {
                  ...originalTask,
                  id: followupTaskId,
                  status: "running",
                  result: null,
                  completedAt: null,
                  completionDelivery: undefined,
                },
              },
              runEvent({
                threadId: child.childThreadId,
                runId: followupRunId,
                ordinal: 3,
                status: "running",
                now,
                delegatedTaskId: followupTaskId,
              }),
            ],
          });
        }
        const secondRunId = RunId.make(`run:later-result-child-${parentState}:2`);
        const checkRecovery = (expected: boolean) =>
          Effect.gen(function* () {
            assert.equal(
              (yield* store.getRecoveryThreadIds("subagent-results")).includes(child.childThreadId),
              expected,
            );
            const events = yield* eventStore.read().pipe(Stream.runCollect);
            yield* Effect.gen(function* () {
              const replay = yield* ProjectionStore.ProjectionStoreV2;
              yield* Effect.forEach(events, (stored) => replay.apply(stored.event), {
                discard: true,
              });
              assert.equal(
                (yield* replay.getRecoveryThreadIds("subagent-results")).includes(
                  child.childThreadId,
                ),
                expected,
              );
            }).pipe(Effect.provide(ProjectionStore.layerMemory));
          });
        yield* terminal(secondRunId, 2, "completed", "Later recovered result.");
        yield* checkRecovery(true);
        if (parentState === "held-pending" || parentState === "held-running") {
          if (parentState === "held-running") {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'running'
              WHERE effect_id = ${`effect:restart-continuation:${secondRunId}`}`;
          }
          yield* orchestrator.recoverDelegatedTasks;
          const held = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            held.contextTransfers
              .filter(
                (row) =>
                  row.type === "subagent_result" && row.sourceThreadId === child.childThreadId,
              )
              .map((row) => row.sourcePoint.runId),
            [child.childRunId],
          );
          assert.equal(
            held.subagents.find((row) => row.id === child.taskId)?.completionDelivery?.state,
            "acknowledged",
          );
          yield* continueRestartedRun({
            threadId: child.childThreadId,
            sourceRunId: secondRunId,
          }).pipe(
            Effect.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false })),
          );
        } else {
          yield* orchestrator.recoverDelegatedTasks;
        }
        yield* checkRecovery(false);
        const after = yield* orchestrator.getThreadProjection(threadId);
        if (
          parentState === "independent-followup" ||
          parentState === "held-pending" ||
          parentState === "held-running"
        ) {
          assert.equal(after.subagents.find((row) => row.id === followupTaskId)?.result, null);
          const independentChild = yield* orchestrator.getThreadProjection(child.childThreadId);
          assert.equal(
            independentChild.runs.find((row) => row.id === followupRunId)?.status,
            "running",
          );
        }
        const transfers = after.contextTransfers.filter(
          (row) => row.type === "subagent_result" && row.sourceThreadId === child.childThreadId,
        );
        assert.deepEqual(
          transfers.map((row) => row.sourcePoint.runId).sort(),
          [child.childRunId, secondRunId].sort(),
        );
        assert.equal(
          transfers.find((row) => row.sourcePoint.runId === child.childRunId)?.id,
          firstTransfer?.id,
        );
        const laterTask = after.subagents.find((row) => row.id === child.taskId);
        assert.equal(laterTask?.result, "Original usage-limit failure.");
        assert.equal(laterTask?.status, "failed");
        const originalCompletedAt = acknowledgedFailure.subagents.find(
          (row) => row.id === child.taskId,
        )?.completedAt;
        assert.isNotNull(laterTask?.completedAt);
        assert.isNotNull(originalCompletedAt);
        assert.equal(
          laterTask?.completedAt == null ? null : DateTime.toEpochMillis(laterTask.completedAt),
          originalCompletedAt == null ? null : DateTime.toEpochMillis(originalCompletedAt),
        );
        assert.equal(laterTask?.completionDelivery?.resultRunId, secondRunId);
        if (parentState === "disposed") {
          assert.equal(laterTask?.completionDelivery?.state, "disposed");
          assert.equal(
            after.runs.find((row) => row.id === parentRunId)?.delegatedCompletion?.disposition,
            "open",
          );
          assert.equal(
            after.runs.find((row) => row.id === parentRunId)?.delegatedCompletion?.delivery,
            null,
          );
          yield* orchestrator.recoverDelegatedTasks;
          const repeatedDisposed = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            repeatedDisposed.contextTransfers.filter(
              (row) => row.type === "subagent_result" && row.sourceThreadId === child.childThreadId,
            ).length,
            2,
          );
          assert.deepEqual(
            repeatedDisposed.runs.find((row) => row.id === parentRunId)?.delegatedCompletion,
            after.runs.find((row) => row.id === parentRunId)?.delegatedCompletion,
          );
          return;
        }
        assert.equal(laterTask?.completionDelivery?.state, "claimed");
        let laterWake = yield* requests.take.pipe(Effect.timeout("3 seconds"));
        while (
          laterWake.threadId !== threadId ||
          laterWake.delegatedCompletion?.generation !==
            after.runs.find((row) => row.id === parentRunId)?.delegatedCompletion?.delivery
              ?.generation
        ) {
          laterWake = yield* requests.take.pipe(Effect.timeout("3 seconds"));
        }
        assert.equal(laterWake.delegatedCompletion?.parentRunId, parentRunId);
        assert.notEqual(
          laterWake.delegatedCompletion?.generation,
          firstWake.delegatedCompletion?.generation,
        );
        if (parentState === "refusal-race") {
          const cleared = yield* Deferred.make<void>();
          const attempts = yield* Ref.make(0);
          const thirdRunId = RunId.make("run:refusal-race:3");
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const inbox =
            yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
          const requestLayer = Layer.succeed(
            ProviderContinuationRequests.ProviderContinuationRequests,
            {
              offer: (request) => Queue.offer(inbox, request).pipe(Effect.asVoid),
              take: Queue.take(inbox),
            },
          );
          const worker = ProviderContinuationService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                IdAllocator.layer,
                requestLayer,
                Layer.succeed(ThreadManagementService.ThreadManagementService, {
                  ...threads,
                  getThreadRecords: threads.getThreadRecords,
                  dispatch: (command) =>
                    command.type === "message.dispatch"
                      ? Effect.gen(function* () {
                          yield* Ref.update(attempts, (count) => count + 1);
                          yield* orchestrator.dispatch({
                            type: "delegated_task.completion-delivery.acknowledge",
                            commandId: CommandId.make("command:refusal-race-second-ack"),
                            parentThreadId: threadId,
                            taskId: child.taskId,
                            resultRunId: secondRunId,
                            observedByRunId: null,
                          });
                          yield* terminal(
                            thirdRunId,
                            3,
                            "completed",
                            "Published during refusal.",
                          ).pipe(Effect.orDie);
                          yield* orchestrator.recoverDelegatedTasks;
                          return yield* new ThreadManagementService.ThreadManagementProviderInstanceDisabledError(
                            {
                              projectId,
                              instanceId: modelSelection.instanceId,
                            },
                          );
                        })
                      : threads.dispatch(command),
                }),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const workerRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
            yield* workerRequests.offer({
              ...laterWake,
              clearIfCurrent: () => Deferred.succeed(cleared, undefined).pipe(Effect.asVoid),
            });
            yield* Effect.yieldNow;
            assert.equal(yield* Ref.get(attempts), 1);
            yield* Deferred.await(cleared).pipe(Effect.timeout("3 seconds"));
            assert.equal(yield* Ref.get(attempts), 1);
            const raced = yield* orchestrator.getThreadProjection(threadId);
            const delivery = raced.subagents.find(
              (row) => row.id === child.taskId,
            )?.completionDelivery;
            assert.equal(delivery?.resultRunId, thirdRunId);
            assert.equal(delivery?.state, "claimed");
            assert.notEqual(delivery?.generation, laterWake.delegatedCompletion?.generation);
            yield* TestClock.adjust("1 hour");
            yield* Effect.yieldNow;
            assert.equal(yield* Ref.get(attempts), 1);
            yield* orchestrator.dispatch({
              type: "delegated_task.completion-delivery.acknowledge",
              commandId: CommandId.make("command:refusal-race-current-ack"),
              parentThreadId: threadId,
              taskId: child.taskId,
              resultRunId: thirdRunId,
              observedByRunId: null,
            });
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
                (row) => row.id === child.taskId,
              )?.completionDelivery?.state,
              "acknowledged",
            );
          }).pipe(Effect.provide(Layer.merge(requestLayer, worker)), Effect.scoped);
          return;
        }
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make(`command:later-stale-ack-${parentState}`),
          parentThreadId: threadId,
          taskId: child.taskId,
          observedByRunId: parentRunId,
          resultRunId: child.childRunId,
        });
        const stale = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          stale.subagents.find((row) => row.id === child.taskId)?.completionDelivery?.state,
          "claimed",
        );
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make(`command:later-omitted-ack-${parentState}`),
          parentThreadId: threadId,
          taskId: child.taskId,
          observedByRunId: parentRunId,
        });
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
            (row) => row.id === child.taskId,
          )?.completionDelivery?.state,
          "claimed",
        );
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.recoverDelegatedTasks;
        const repeated = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          repeated.contextTransfers.filter(
            (row) => row.type === "subagent_result" && row.sourceThreadId === child.childThreadId,
          ).length,
          2,
        );
        assert.deepEqual(
          repeated.runs.find((row) => row.id === parentRunId)?.delegatedCompletion,
          stale.runs.find((row) => row.id === parentRunId)?.delegatedCompletion,
        );
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make(`command:later-current-ack-${parentState}`),
          parentThreadId: threadId,
          taskId: child.taskId,
          observedByRunId: parentRunId,
          resultRunId: secondRunId,
        });
        const acknowledged = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          acknowledged.subagents.find((row) => row.id === child.taskId)?.completionDelivery?.state,
          "acknowledged",
        );
        const childResult = yield* orchestrator.getThreadProjection(child.childThreadId);
        assert.deepEqual(
          childResult.messages
            .filter((row) => row.role === "assistant")
            .map((row) => row.text)
            .sort(),
          ["Later recovered result.", "Original usage-limit failure."],
        );
      }),
    );
  },
);

it.effect(
  "recovers a later task result after reopening SQLite while an independent follow-up runs",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-later-result-reopen-" });
      const persistence = SqlitePersistence.layerFromPath(`${directory}/state.sqlite`);
      const threadId = ThreadId.make("thread:reopen-parent");
      const projectId = ProjectId.make("project:reopen-parent");
      const parentRunId = RunId.make("run:reopen-parent");
      const rootNodeId = NodeId.make("node:reopen-parent");
      const secondRunId = RunId.make("run:reopen-child:2");
      const independentRunId = RunId.make("run:reopen-child:3");
      const child = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:reopen-seed"),
          deliveryState: "delivered",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "reopen-child",
          completionWake: "always",
          continuationPending: false,
          now,
        });
        yield* eventSink.write({
          commandId: reconcileCommandId("reopen-first-terminal"),
          events: [
            runEvent({
              threadId: child.childThreadId,
              runId: child.childRunId,
              ordinal: 1,
              status: "failed",
              delegatedTaskId: child.taskId,
              now,
            }),
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:reopen-first-ack"),
          parentThreadId: threadId,
          taskId: child.taskId,
          resultRunId: child.childRunId,
          observedByRunId: parentRunId,
        });
        const first = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === child.taskId,
        );
        if (first === undefined) return yield* Effect.die("Missing original task.");
        yield* eventSink.write({
          commandId: reconcileCommandId("reopen-later-terminal"),
          events: [
            {
              id: EventId.make("event:reopen-independent-task"),
              type: "subagent.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...first,
                id: NodeId.make("node:reopen-independent"),
                status: "running",
                result: null,
                completedAt: null,
                completionDelivery: undefined,
              },
            },
            runEvent({
              threadId: child.childThreadId,
              runId: independentRunId,
              ordinal: 3,
              status: "running",
              delegatedTaskId: NodeId.make("node:reopen-independent"),
              now,
            }),
            {
              id: EventId.make("event:reopen-result"),
              type: "message.updated",
              threadId: child.childThreadId,
              runId: secondRunId,
              occurredAt: now,
              payload: {
                id: MessageId.make("message:reopen-result"),
                threadId: child.childThreadId,
                runId: secondRunId,
                nodeId: null,
                role: "assistant",
                text: "Recovered after reopening.",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "server",
                createdAt: now,
                updatedAt: now,
              },
            },
            runEvent({
              threadId: child.childThreadId,
              runId: secondRunId,
              ordinal: 2,
              status: "completed",
              delegatedTaskId: child.taskId,
              now,
            }),
          ],
        });
        return {
          ...child,
          completedAt: first.completedAt == null ? null : DateTime.toEpochMillis(first.completedAt),
        };
      }).pipe(Effect.provide(makeLayerTest(persistence)), Effect.scoped);

      const generation = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        assert.deepEqual(yield* store.getRecoveryThreadIds("subagent-results"), [
          child.childThreadId,
        ]);
        const selected = yield* store.getThreadRecords(threadId, ["subagents"]);
        assert.deepEqual(Object.keys(selected).sort(), ["subagents", "thread"]);
        yield* orchestrator.recoverDelegatedTasks;
        assert.deepEqual(yield* store.getRecoveryThreadIds("subagent-results"), []);
        const parent = yield* orchestrator.getThreadProjection(threadId);
        const task = parent.subagents.find((task) => task.id === child.taskId);
        assert.equal(task?.status, "failed");
        assert.equal(task?.result, "Child task ended with status failed.");
        assert.equal(
          task?.completedAt == null ? null : DateTime.toEpochMillis(task.completedAt),
          child.completedAt,
        );
        assert.equal(task?.completionDelivery?.resultRunId, secondRunId);
        assert.equal(task?.completionDelivery?.state, "claimed");
        assert.deepEqual(
          parent.contextTransfers
            .filter((transfer) => transfer.type === "subagent_result")
            .map((transfer) => transfer.sourcePoint.runId)
            .sort(),
          [child.childRunId, secondRunId].sort(),
        );
        assert.equal(
          (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.find(
            (run) => run.id === independentRunId,
          )?.status,
          "running",
        );
        const offer = yield* requests.take;
        assert.equal(offer.threadId, threadId);
        assert.equal(offer.delegatedCompletion?.generation, task?.completionDelivery?.generation);
        return task?.completionDelivery?.generation;
      }).pipe(
        Effect.provide(Layer.merge(makeLayerTest(persistence), ProviderContinuationRequests.layer)),
        Effect.scoped,
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.recoverDelegatedTasks;
        const parent = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          parent.contextTransfers.filter((transfer) => transfer.type === "subagent_result").length,
          2,
        );
        assert.equal(
          parent.subagents.find((task) => task.id === child.taskId)?.completionDelivery?.generation,
          generation,
        );
      }).pipe(Effect.provide(makeLayerTest(persistence)), Effect.scoped);
    }).pipe(Effect.provide(layerPlatformTest), Effect.scoped),
);

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "unpublished original result gates",
  (it) => {
    it.effect.each([
      "nested-running",
      "nested-pending",
      "nested-claimed",
      "background",
      "independent",
      "legacy",
    ])("waits for %s before publishing and offering the original result", (gate) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`thread:original-gate-${gate}`);
        const projectId = ProjectId.make(`project:original-gate-${gate}`);
        const parentRunId = RunId.make(`run:original-gate-${gate}`);
        const rootNodeId = NodeId.make(`node:original-gate-${gate}`);
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make(`node:original-gate-seed-${gate}`),
          deliveryState: "delivered",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: `original-gate-child-${gate}`,
          completionWake: "always",
          continuationPending: false,
          now,
        });
        const parent = yield* orchestrator.getThreadProjection(threadId);
        const original = parent.subagents.find((task) => task.id === child.taskId);
        const providerThread = parent.providerThreads[0];
        if (original === undefined || providerThread === undefined)
          return yield* Effect.die("Missing gate fixture.");
        const nestedId = NodeId.make(`node:gate-nested-${gate}`);
        const backgroundProviderId = ProviderThreadId.make(`provider-thread:gate-${gate}`);
        const extraRunId = RunId.make(`run:gate-extra-${gate}`);
        if (gate === "independent") {
          yield* sink.write({
            commandId: reconcileCommandId("original-independent-task"),
            events: [
              {
                id: EventId.make("event:original-independent-task"),
                type: "subagent.updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...original,
                  id: NodeId.make(`node:gate-independent-${gate}`),
                  result: null,
                  completedAt: null,
                },
              },
            ],
          });
        }
        const blockerEvents = (settled: boolean) => {
          if (gate === "independent" || gate === "legacy") {
            return [
              runEvent({
                threadId: child.childThreadId,
                runId: extraRunId,
                ordinal: 2,
                status: settled ? "completed" : "running",
                now,
                ...(gate === "legacy"
                  ? {}
                  : { delegatedTaskId: NodeId.make(`node:gate-independent-${gate}`) }),
              }),
            ];
          }
          if (gate === "background") {
            return [
              {
                id: EventId.make(`event:gate-background-${gate}-${settled}`),
                type: "provider-thread.updated",
                threadId: child.childThreadId,
                occurredAt: now,
                payload: {
                  ...providerThread,
                  id: backgroundProviderId,
                  appThreadId: child.childThreadId,
                  pendingBackgroundTasks: settled
                    ? []
                    : [{ kind: "command", taskId: "synthetic-background" }],
                },
              } satisfies OrchestrationV2DomainEvent,
            ];
          }
          return [
            {
              id: EventId.make(`event:gate-nested-${gate}-${settled}`),
              type: "subagent.updated",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: {
                ...original,
                id: nestedId,
                threadId: child.childThreadId,
                childThreadId: null,
                status: !settled && gate === "nested-running" ? "running" : "completed",
                result: settled ? "Nested result consumed." : null,
                completionDelivery: {
                  state: settled
                    ? "acknowledged"
                    : gate === "nested-claimed"
                      ? "claimed"
                      : "pending",
                  observedByRunId: null,
                },
              },
            } satisfies OrchestrationV2DomainEvent,
          ];
        };
        yield* sink.write({
          commandId: reconcileCommandId(`original-gate-block-${gate}`),
          events: [
            runEvent({
              threadId: child.childThreadId,
              runId: child.childRunId,
              ordinal: 1,
              status: "completed",
              now,
              ...(gate === "legacy" ? {} : { delegatedTaskId: child.taskId }),
            }),
            ...blockerEvents(false),
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(held.subagents.find((task) => task.id === child.taskId)?.result, null);
        assert.deepEqual(
          held.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
          [],
        );
        assert.equal(
          held.runs.find((run) => run.id === parentRunId)?.delegatedCompletion?.delivery,
          null,
        );
        yield* sink.write({
          commandId: reconcileCommandId(`original-gate-release-${gate}`),
          events: blockerEvents(true),
        });
        yield* orchestrator.recoverDelegatedTasks;
        const released = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          released.subagents.find((task) => task.id === child.taskId)?.result,
          "Child task completed without an assistant result.",
        );
        assert.equal(
          released.subagents.find((task) => task.id === child.taskId)?.completionDelivery?.state,
          "claimed",
        );
        assert.equal(
          released.contextTransfers.filter((transfer) => transfer.type === "subagent_result")
            .length,
          gate === "independent" ? 2 : 1,
        );
        let offer = yield* requests.take;
        while (offer.threadId !== threadId) offer = yield* requests.take;
        assert.equal(offer.delegatedCompletion?.parentRunId, parentRunId);
        yield* orchestrator.recoverDelegatedTasks;
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).contextTransfers.filter(
            (transfer) => transfer.type === "subagent_result",
          ).length,
          gate === "independent" ? 2 : 1,
        );
      }),
    );
  },
);

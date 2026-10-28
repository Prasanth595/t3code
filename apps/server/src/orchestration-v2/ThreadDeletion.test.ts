import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as TemporaryThreadDiagnostics from "../observability/TemporaryThreadDiagnostics.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TemporaryThreadStorage from "./TemporaryThreadStorage.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { applyToProjection, emptyProjection } from "./ProjectionStore.ts";
import { planThreadDeletion } from "./ThreadDeletion.ts";

const threadId = ThreadId.make("thread:delete-plan");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:delete-plan");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const createdAt = DateTime.makeUnsafe("2026-09-01T00:00:00.000Z");
const deletedAt = DateTime.makeUnsafe("2026-09-04T00:00:00.000Z");
const command = {
  type: "thread.delete" as const,
  commandId: CommandId.make("command:delete-plan"),
  threadId,
};

function makeProjection(): OrchestrationV2ThreadProjection {
  const base = emptyProjection({
    id: EventId.make("event:delete-plan-created"),
    type: "thread.created",
    threadId,
    occurredAt: createdAt,
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("project:delete-plan"),
      title: "Delete the thread",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature",
      worktreePath: "/workspace/feature",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const runs: Array<OrchestrationV2Run> = (
    ["preparing", "queued", "starting", "running", "waiting", "completed"] as const
  ).map((status, index) => ({
    id: RunId.make(`run:delete-plan:${status}`),
    threadId,
    ordinal: index + 1,
    providerInstanceId,
    modelSelection,
    providerThreadId,
    userMessageId: MessageId.make(`message:delete-plan:${status}`),
    rootNodeId: NodeId.make(`node:delete-plan:${status}`),
    activeAttemptId: RunAttemptId.make(`attempt:delete-plan:${status}`),
    status,
    queuePosition: status === "queued" ? 1 : null,
    requestedAt: createdAt,
    startedAt: createdAt,
    completedAt: status === "completed" ? createdAt : null,
    checkpointId: null,
    contextHandoffId: null,
  }));
  return {
    ...base,
    runs,
    attempts: runs.map((run) => ({
      id: run.activeAttemptId!,
      runId: run.id,
      attemptOrdinal: 1,
      rootNodeId: run.rootNodeId!,
      providerInstanceId,
      providerThreadId,
      providerTurnId: null,
      reason: "initial",
      status: run.status === "completed" ? "completed" : "running",
      startedAt: createdAt,
      completedAt: run.completedAt,
    })),
    nodes: runs.map((run) => ({
      id: run.rootNodeId!,
      threadId,
      runId: run.id,
      parentNodeId: null,
      rootNodeId: run.rootNodeId!,
      kind: "root_turn",
      status: run.status === "completed" ? "completed" : "waiting",
      countsForRun: true,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: createdAt,
      completedAt: run.completedAt,
    })),
    runtimeRequests: ["pending", "resolved"].map((status) => ({
      id: RuntimeRequestId.make(`request:delete-plan:${status}`),
      nodeId: runs[3]!.rootNodeId!,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: status === "pending" ? "pending" : "resolved",
      responseCapability: { type: "message" },
      createdAt,
      resolvedAt: status === "resolved" ? createdAt : null,
    })),
  };
}

it.effect("cancels active work without reviving a run while disposing delegated completion", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const parentRun = base.runs.find((run) => run.status === "running")!;
    const queuedRun = base.runs.find((run) => run.status === "queued")!;
    const taskId = NodeId.make("task:delete-plan");
    const projection: OrchestrationV2ThreadProjection = {
      ...base,
      runs: base.runs.map((run) =>
        run.id === parentRun.id
          ? {
              ...run,
              delegatedCompletion: {
                disposition: "open",
                nextGeneration: 3,
                delivery: { generation: 2, messageId: queuedRun.userMessageId, taskIds: [taskId] },
              },
            }
          : run,
      ),
      subagents: [
        {
          id: taskId,
          threadId,
          runId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Inspect the project",
          title: null,
          model: null,
          completionDelivery: { state: "claimed", observedByRunId: null },
          status: "completed",
          result: "done",
          startedAt: createdAt,
          completedAt: createdAt,
          updatedAt: createdAt,
        },
      ],
    };
    const plan = yield* planThreadDeletion({
      command,
      projection,
      attachmentIds: projection.messages.flatMap((message) =>
        message.attachments.map((attachment) => attachment.id),
      ),
      now: deletedAt,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
    });
    const deleted = plan.events.reduce(applyToProjection, projection);
    assert.deepEqual(deleted.thread.deletedAt, deletedAt);
    assert.equal(deleted.thread.worktreePath, "/workspace/feature");
    assert.isNull(projection.thread.deletedAt);
    for (const run of deleted.runs) {
      assert.equal(run.status, run.id.endsWith(":completed") ? "completed" : "cancelled");
      assert.deepEqual(run.completedAt, run.id.endsWith(":completed") ? createdAt : deletedAt);
    }
    for (const attempt of deleted.attempts) {
      assert.equal(
        attempt.status,
        attempt.runId.endsWith(":completed") ? "completed" : "cancelled",
      );
    }
    for (const node of deleted.nodes) {
      assert.equal(node.status, node.runId?.endsWith(":completed") ? "completed" : "cancelled");
    }
    const pending = deleted.runtimeRequests.find((request) => request.id.endsWith(":pending"))!;
    assert.equal(pending.status, "cancelled");
    assert.deepEqual(pending.responseCapability, {
      type: "not_resumable",
      reason: "The thread was deleted.",
    });
    assert.deepEqual(deleted.runtimeRequests[1], projection.runtimeRequests[1]);
    assert.deepEqual(deleted.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion, {
      disposition: "disposed",
      nextGeneration: 3,
      delivery: null,
    });
    assert.equal(deleted.subagents[0]?.completionDelivery?.state, "disposed");
    const queuedRunUpdates = plan.events.filter(
      (event) => event.type === "run.updated" && event.payload.id === queuedRun.id,
    );
    assert.lengthOf(queuedRunUpdates, 1);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each([false, true])(
  "permanent deletion closes a kept temporary runtime with prior settle=%s",
  (settled) =>
    Effect.gen(function* () {
      const closed = yield* Ref.make<ReadonlyArray<ProviderSessionId>>([]);
      const adapter = ProviderAdapter.ProviderAdapterV2.of({
        instanceId: providerInstanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Ref.update(closed, (ids) => [...ids, input.providerSessionId]),
            );
            const capabilities = {
              ...CodexProviderCapabilitiesV2,
              sessions: {
                ...CodexProviderCapabilitiesV2.sessions,
                supportsMultipleProviderThreadsPerSession: !input.runtimePolicy.temporary,
              },
            };
            return {
              instanceId: providerInstanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                providerInstanceId,
                driver,
                status: "ready" as const,
                cwd: process.cwd(),
                model: modelSelection.model,
                capabilities,
                createdAt,
                updatedAt: createdAt,
                lastError: null,
              },
              events: Stream.never,
              ensureThread: () => Effect.die("unused ensureThread"),
              resumeThread: () => Effect.die("unused resumeThread"),
              startTurn: () => Effect.void,
              steerTurn: () => Effect.void,
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
              rollbackThread: () => Effect.die("unused rollbackThread"),
              forkThread: () => Effect.die("unused forkThread"),
            } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
          }),
      });
      const stores = TemporaryThreadStorage.layer.pipe(
        Layer.provide(Sqlite.layerMemory),
        Layer.provide(TemporaryThreadDiagnostics.layer),
      );
      const managerLayer = ProviderSessionManager.layerWithOptions({ configureMcp: false }).pipe(
        Layer.provideMerge(stores),
        Layer.provideMerge(IdAllocator.layer),
        Layer.provide(ProviderAdapterRegistry.layerSingle(adapter)),
        Layer.provide(McpProviderSessions.layer),
        Layer.provide(McpSessionRegistryTestkit.layer),
        Layer.provide(Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({})),
        Layer.provide(CommandOutputHub.layer.pipe(Layer.provide(stores))),
        Layer.provide(NodeServices.layer),
      );
      const executor = EffectWorker.layerExecutor.pipe(
        Layer.provideMerge(managerLayer),
        Layer.provide(Layer.mock(RunFinalizationService.RunFinalizationService)({})),
        Layer.provide(Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({})),
        Layer.provide(Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({})),
        Layer.provide(Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({})),
        Layer.provide(Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({})),
        Layer.provide(
          Layer.mock(ThreadTitleRegenerationService.ThreadTitleRegenerationService)({}),
        ),
        Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
        Layer.provide(ServerSettings.layerTest()),
      );
      const layer = EffectWorker.layer.pipe(Layer.provideMerge(executor));
      yield* Effect.gen(function* () {
        const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
        const sink = yield* EventSink.EventSinkV2;
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const sessionId = ProviderSessionId.make("session:kept-delete");
        const sharedSessionId = ProviderSessionId.make("session:saved-shared");
        const savedOwner = ThreadId.make("thread:saved-owner");
        const savedPeer = ThreadId.make("thread:saved-peer");
        yield* storage.register({ threadId });
        for (const id of [threadId, savedOwner, savedPeer]) {
          yield* sink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId: id }),
                type: "thread.created",
                threadId: id,
                occurredAt: createdAt,
                payload: {
                  ...makeProjection().thread,
                  id,
                  worktreePath: null,
                  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
                },
              },
            ],
          });
          yield* manager.open({
            threadId: id,
            providerSessionId: id === threadId ? sessionId : sharedSessionId,
            modelSelection,
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: null,
              temporary: id === threadId,
            },
          });
        }
        yield* storage.keep({ threadId, commandId: CommandId.make("keep:delete-test") });
        assert.isFalse(yield* storage.isTemporary(threadId));
        assert.isTrue(yield* manager.isLive(sessionId));
        if (settled) {
          const settleId = CommandId.make("settle:delete-test");
          yield* sink.commitCommand({
            threadId,
            commandId: settleId,
            commandType: "thread.settle",
            acceptedAt: deletedAt,
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId }),
                type: "thread.settled",
                threadId,
                occurredAt: deletedAt,
                payload: { ...(yield* projectionStore.getThread(threadId)), settledAt: deletedAt },
              },
              {
                id: yield* idAllocator.allocate.event({ threadId }),
                type: "provider-session.detached",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  providerSessionId: sessionId,
                  detachedAt: deletedAt,
                  reason: "Thread settled.",
                },
              },
            ],
            effects: [
              {
                id: "effect:settle:delete-test",
                commandId: settleId,
                threadId,
                request: { type: "provider-session.detach", providerSessionId: sessionId },
              },
            ],
          });
          yield* worker.drain();
          assert.deepEqual(
            (yield* projectionStore.getThreadRecords(threadId, ["providerSessions"]))
              .providerSessions,
            [],
          );
          assert.isTrue(yield* manager.isLive(sessionId));
          assert.deepEqual(yield* Ref.get(closed), []);
        }
        for (const id of [threadId, savedOwner]) {
          const deleteCommand = {
            ...command,
            threadId: id,
            commandId: CommandId.make("delete:" + id),
          };
          const plan = yield* planThreadDeletion({
            command: deleteCommand,
            projection: yield* projectionStore
              .getThreadSnapshot(id)
              .pipe(Effect.map((snapshot) => snapshot.projection)),
            attachmentIds: [],
            now: deletedAt,
            idAllocator,
          });
          yield* sink.commitCommand({
            threadId: id,
            commandId: deleteCommand.commandId,
            commandType: deleteCommand.type,
            acceptedAt: deletedAt,
            ...plan,
          });
          yield* worker.drain();
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          assert.isTrue(
            (yield* outbox.listByCommandId(deleteCommand.commandId)).every(
              (effect) => effect.status === "succeeded",
            ),
          );
          assert.isFalse(yield* manager.isLive(sessionId));
          assert.deepEqual(yield* Ref.get(closed), [sessionId]);
          assert.isTrue(yield* manager.isLive(sharedSessionId));
        }
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("requeues terminal temporary release after a worker process is lost", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    yield* outbox.enqueue([
      {
        id: "effect:deleted-temporary-owner",
        commandId: command.commandId,
        threadId,
        request: { type: "provider-session.release-temporary" },
      },
    ]);
    yield* outbox.claimNext({ workerId: "lost-worker" });
    assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { cancelled: 0, requeued: 1 });
    const reclaimed = yield* outbox.claimNext({ workerId: "new-worker" });
    assert.isTrue(Option.isSome(reclaimed));
    if (Option.isSome(reclaimed)) {
      assert.equal(reclaimed.value.request.type, "provider-session.release-temporary");
      assert.equal(reclaimed.value.attemptCount, 2);
    }
  }).pipe(Effect.provide(EffectOutbox.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);

it.effect("queues provider and resource cleanup and preserves an earlier deletion timestamp", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const projection: OrchestrationV2ThreadProjection = {
      ...base,
      thread: { ...base.thread, deletedAt: createdAt },
      providerSessions: ["running", "stopped", "error"].map((status) => ({
        id: ProviderSessionId.make(`session:delete-plan:${status}`),
        driver,
        providerInstanceId,
        status: status === "running" ? "running" : status === "stopped" ? "stopped" : "error",
        cwd: "/workspace/feature",
        model: null,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt,
        updatedAt: createdAt,
        lastError: null,
      })),
      messages: [0, 1].map((index) => ({
        id: MessageId.make(`message:attachment:${index}`),
        threadId,
        createdBy: "user",
        creationSource: "web",
        runId: null,
        nodeId: null,
        role: "user",
        text: "Inspect this file",
        attachments: [
          {
            type: "file",
            id: "shared_file",
            name: "input.txt",
            mimeType: "text/plain",
            sizeBytes: 10,
          },
        ],
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      })),
    };
    const plan = yield* planThreadDeletion({
      command,
      projection,
      attachmentIds: projection.messages.flatMap((message) =>
        message.attachments.map((attachment) => attachment.id),
      ),
      now: deletedAt,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
    });
    const deleted = plan.events.reduce(applyToProjection, projection);
    assert.deepEqual(deleted.thread.deletedAt, createdAt);
    assert.deepEqual(
      deleted.providerSessions.map((session) => session.status),
      ["stopped", "error"],
    );
    assert.deepEqual(
      plan.effects.map((effect) => effect.request),
      [
        {
          type: "provider-session.detach",
          providerSessionId: ProviderSessionId.make("session:delete-plan:running"),
          detail: "Thread deleted.",
          revokeMcpCredential: true,
        },
        { type: "provider-session.release-temporary", detail: "Thread deleted." },
        { type: "scheduled-tasks.cleanup" },
        { type: "terminal.cleanup" },
        { type: "preview.cleanup" },
        { type: "attachment.cleanup", attachmentIds: ["shared_file"] },
      ],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);

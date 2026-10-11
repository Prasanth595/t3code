import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, type ThreadId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  boot,
  controlledSwarmLayer,
  create,
  humanFollowup,
  modelSelection,
  ownerId,
  peer,
} from "./SwarmTestFixture.ts";
import { delegatedTaskProgressForTask } from "@t3tools/provider-core/server/subagentProjection";
import {
  type Finishers,
  type ProviderEvents,
  delegate,
  finishRun,
  taskStatus,
  publishBackground,
} from "./DelegatedTaskTestFixture.ts";

it.effect.each([
  { creationSource: "web", legacy: false },
  { creationSource: "mcp", legacy: false },
  { creationSource: "web", legacy: true },
] as const)(
  "r3 generic failure publishes with held $creationSource followup and legacy $legacy initial",
  ({ creationSource, legacy }) =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const finishers = yield* Ref.make<Finishers>(new Map());
      yield* Effect.gen(function* () {
        yield* boot;
        const task = yield* delegate("generic-failure");
        const childId = task.childThreadId!;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        yield* worker.drain(30);
        const initial = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
        assert.equal(initial.status, "running");
        if (legacy) {
          const { delegatedTaskId: _, ...unbound } = initial;
          yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
            id: EventId.make("legacy-initial"),
            type: "run.updated",
            threadId: childId,
            runId: initial.id,
            occurredAt: initial.requestedAt,
            payload: unbound,
          });
        }
        yield* humanFollowup(childId, "held-human", creationSource);
        const held = yield* Deferred.make<void>();
        const watcher = yield* sink.stream({ threadId: childId, eventType: "run.updated" }).pipe(
          Stream.runForEach((stored) =>
            stored.event.type === "run.updated" && stored.event.payload.queueHeld === true
              ? Deferred.succeed(held, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkChild,
        );
        yield* finishRun(finishers, initial, "failed", "Initial provider failed.");
        yield* Deferred.await(held);
        yield* orchestrator.recoverDelegatedTask(childId, initial.id);
        const parent = yield* orchestrator.getThreadProjection(ownerId);
        const published = parent.subagents.find((row) => row.id === task.id)!;
        const child = yield* orchestrator.getThreadProjection(childId);
        assert.deepEqual(
          { status: published.status, result: published.result },
          { status: "failed", result: "Initial provider failed." },
        );
        assert.equal(child.runs[1]?.queueHeld, true);
        assert.equal(child.runs[1]?.delegatedTaskId, task.id);
        assert.equal(
          parent.contextTransfers.find(
            (transfer) =>
              transfer.type === "subagent_result" && transfer.sourceThreadId === childId,
          )?.sourcePoint.runId,
          initial.id,
        );
        const status = yield* taskStatus(task.id);
        assert.deepEqual(
          {
            status: status.status,
            summary: status.summary,
            workState: status.workState,
            childRunId: status.childRunId,
            hasPending: status.hasPendingChildRuns,
          },
          {
            status: "failed",
            summary: "Initial provider failed.",
            workState: "result_available",
            childRunId: initial.id,
            hasPending: false,
          },
        );
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("remove-held"),
          threadId: childId,
          runId: child.runs[1]!.id,
        });
        yield* orchestrator.recoverDelegatedTask(childId, initial.id);
        const after = yield* orchestrator.getThreadProjection(ownerId);
        const unchanged = after.subagents.find((row) => row.id === task.id)!;
        assert.deepEqual(
          { status: unchanged.status, result: unchanged.result },
          { status: "failed", result: "Initial provider failed." },
        );
        assert.deepEqual(
          after.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
          parent.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
        );
        yield* Fiber.interrupt(watcher);
      }).pipe(Effect.provide(controlledSwarmLayer({ turns, finishers })));
    }),
);

it.effect.each([
  { kind: "generic", status: "completed" },
  { kind: "generic", status: "failed" },
  { kind: "swarm-human", status: "completed" },
  { kind: "swarm-peer", status: "completed" },
] as const)(
  "r3 removing unstarted $kind followup preserves $status executed result",
  ({ kind, status }) =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const finishers = yield* Ref.make<Finishers>(new Map());
      yield* Effect.gen(function* () {
        yield* boot;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const generic = kind === "generic" ? yield* delegate("generic-cancel") : undefined;
        const group = kind === "generic" ? undefined : (yield* create()).group;
        const taskId = generic?.id ?? group!.members[1]!.taskId;
        const childId = generic?.childThreadId ?? group!.members[1]!.threadId;
        yield* worker.drain(30);
        const initial = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
        if (kind === "swarm-peer") yield* peer(group!, 0, 1, "cancel-peer");
        else yield* humanFollowup(childId, "cancel-human");
        const queued = (yield* orchestrator.getThreadProjection(childId)).runs[1]!;
        assert.equal(queued.startedAt, null);
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("remove-unstarted"),
          threadId: childId,
          runId: queued.id,
        });
        yield* finishRun(finishers, initial, status, "Executed original result.");
        yield* orchestrator.recoverDelegatedTask(childId, initial.id);
        const parent = yield* orchestrator.getThreadProjection(ownerId);
        const published = parent.subagents.find((row) => row.id === taskId)!;
        assert.deepEqual(
          { status: published.status, result: published.result },
          { status, result: "Executed original result." },
        );
        assert.equal(
          parent.contextTransfers.find(
            (transfer) =>
              transfer.type === "subagent_result" && transfer.sourceThreadId === childId,
          )?.sourcePoint.runId,
          initial.id,
        );
        const result = yield* taskStatus(taskId);
        assert.equal(result.summary, "Executed original result.");
        assert.equal(result.status, status);
        assert.equal(result.childRunId, initial.id);
      }).pipe(Effect.provide(controlledSwarmLayer({ turns, finishers })));
    }),
);

it.effect("r3 ordinary queue promotion owns the parent lock before allocating a fresh task", () =>
  Effect.gen(function* () {
    const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
    const finishers = yield* Ref.make<Finishers>(new Map());
    yield* Effect.gen(function* () {
      yield* boot;
      const task = yield* delegate("lock-child");
      const childId = task.childThreadId!;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* worker.drain(30);
      yield* humanFollowup(childId, "run-two");
      yield* humanFollowup(childId, "run-three");
      const initial = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
      yield* finishRun(finishers, initial, "completed", "Original completed.");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("promote-two"),
        threadId: childId,
      });
      yield* worker.drain(30);
      const second = (yield* orchestrator.getThreadProjection(childId)).runs[1]!;
      const held = yield* Deferred.make<void>();
      const watcher = yield* sink.stream({ threadId: childId, eventType: "run.updated" }).pipe(
        Stream.runForEach((stored) =>
          stored.event.type === "run.updated" &&
          stored.event.payload.ordinal === 3 &&
          stored.event.payload.queueHeld === true
            ? Deferred.succeed(held, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkChild,
      );
      yield* finishRun(finishers, second, "failed", "Second failed.");
      yield* Deferred.await(held);
      yield* orchestrator.recoverDelegatedTask(childId, second.id);
      assert.equal(
        (yield* orchestrator.getThreadProjection(ownerId)).subagents.find(
          (row) => row.id === task.id,
        )?.result,
        "Second failed.",
      );
      const allocated = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const originalOrdinal = store.getNextTurnItemOrdinal;
      let pause = true;
      const ordinalSpy = vi.spyOn(store, "getNextTurnItemOrdinal").mockImplementation((id) =>
        Effect.gen(function* () {
          const ordinal = yield* originalOrdinal(id);
          if (id === ownerId && pause) {
            pause = false;
            yield* Deferred.succeed(allocated, undefined);
            yield* Deferred.await(release);
          }
          return ordinal;
        }),
      );
      const promotion = yield* orchestrator
        .dispatch({
          type: "queue.resume",
          commandId: CommandId.make("promote-three"),
          threadId: childId,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(allocated);
      const protectedParent = (yield* executor.activeKeys).includes(ownerId);
      const parentAttempt = yield* Deferred.make<void>();
      const originalLock = executor.withLock;
      const lockSpy = vi
        .spyOn(executor, "withLock")
        .mockImplementation(<A, E, R>(id: ThreadId, effect: Effect.Effect<A, E, R>) =>
          id === ownerId
            ? Deferred.succeed(parentAttempt, undefined).pipe(
                Effect.andThen(originalLock(id, effect)),
              )
            : originalLock(id, effect),
        );
      const concurrent = yield* Effect.gen(function* () {
        yield* delegate("concurrent-parent");
        yield* orchestrator.dispatch({
          type: "delegated_task.wake-policy",
          commandId: CommandId.make("parent-policy"),
          parentThreadId: ownerId,
          taskId: task.id,
          completionWake: "always",
        });
      }).pipe(Effect.forkChild);
      yield* Deferred.await(parentAttempt);
      if (!protectedParent) yield* Fiber.join(concurrent);
      const prematureParentWrite = (yield* orchestrator.getThreadProjection(
        ownerId,
      )).subagents.some((row) => row.prompt === "concurrent-parent");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(promotion);
      yield* Fiber.join(concurrent);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        ordinal: number;
        count: number;
      }>`SELECT ordinal,COUNT(*) AS count FROM orchestration_v2_projection_turn_items WHERE thread_id = ${ownerId} GROUP BY ordinal HAVING COUNT(*) > 1`;
      const parent = yield* orchestrator.getThreadProjection(ownerId);
      assert.deepEqual(
        { protectedParent, duplicates: rows },
        { protectedParent: true, duplicates: [] },
      );
      assert.equal(prematureParentWrite, false);
      assert.equal(parent.subagents.find((row) => row.id === task.id)?.completionWake, "always");
      assert.deepEqual(parent.subagents.map((row) => row.prompt).toSorted(), [
        "concurrent-parent",
        "lock-child",
        "run-three",
      ]);
      assert.deepEqual(
        parent.turnItems.filter((item) => item.type === "subagent").map((item) => item.ordinal),
        [1000002, 1000003, 1000004],
      );
      ordinalSpy.mockRestore();
      lockSpy.mockRestore();
      yield* Fiber.interrupt(watcher);
    }).pipe(Effect.provide(controlledSwarmLayer({ turns, finishers })));
  }),
);

it.effect(
  "r3 postpublication tasks publish separately and preserve a never-started task cancellation",
  () =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const finishers = yield* Ref.make<Finishers>(new Map());
      yield* Effect.gen(function* () {
        yield* boot;
        const task = yield* delegate("separate-original");
        const childId = task.childThreadId!;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain(30);
        const initial = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
        assert.equal(initial.delegatedTaskId, task.id);
        yield* finishRun(finishers, initial, "completed", "First immutable result.");
        yield* orchestrator.recoverDelegatedTask(childId, initial.id);
        const originalParent = yield* orchestrator.getThreadProjection(ownerId);
        const originalTransfer = originalParent.contextTransfers.find(
          (transfer) => transfer.type === "subagent_result" && transfer.sourceThreadId === childId,
        )!;
        yield* humanFollowup(childId, "second-owned");
        yield* worker.drain(30);
        const second = (yield* orchestrator.getThreadProjection(childId)).runs[1]!;
        yield* humanFollowup(childId, "cancelled-owned");
        const third = (yield* orchestrator.getThreadProjection(childId)).runs[2]!;
        assert.notEqual(second.delegatedTaskId, task.id);
        assert.notEqual(third.delegatedTaskId, second.delegatedTaskId);
        assert.equal(third.startedAt, null);
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("cancel-owned-task"),
          threadId: childId,
          runId: third.id,
        });
        yield* orchestrator.recoverDelegatedTask(childId, third.id);
        const cancelled = yield* taskStatus(third.delegatedTaskId!);
        assert.deepEqual(
          {
            status: cancelled.status,
            summary: cancelled.summary,
            childRunId: cancelled.childRunId,
          },
          {
            status: "cancelled",
            summary: "Child task ended with status cancelled.",
            childRunId: third.id,
          },
        );
        const stillRunning = yield* taskStatus(second.delegatedTaskId!);
        assert.equal(stillRunning.status, "running");
        yield* finishRun(finishers, second, "completed", "Second separate result.");
        yield* orchestrator.recoverDelegatedTask(childId, second.id);
        const parent = yield* orchestrator.getThreadProjection(ownerId);
        assert.equal(
          parent.subagents.find((row) => row.id === task.id)?.result,
          "First immutable result.",
        );
        assert.equal(
          parent.subagents.find((row) => row.id === second.delegatedTaskId)?.result,
          "Second separate result.",
        );
        assert.equal(
          parent.subagents.find((row) => row.id === third.delegatedTaskId)?.status,
          "cancelled",
        );
        assert.deepEqual(
          parent.contextTransfers.find((transfer) => transfer.id === originalTransfer.id),
          originalTransfer,
        );
        assert.deepEqual(
          parent.contextTransfers
            .filter(
              (transfer) =>
                transfer.type === "subagent_result" && transfer.sourceThreadId === childId,
            )
            .map((transfer) => transfer.sourcePoint.runId)
            .toSorted(),
          [initial.id, second.id, third.id].toSorted(),
        );
        assert.equal((yield* taskStatus(task.id)).summary, "First immutable result.");
      }).pipe(Effect.provide(controlledSwarmLayer({ turns, finishers })));
    }),
);

it.effect("r3 a removed owned followup remains separate from another task's nested work", () =>
  Effect.gen(function* () {
    const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
    const finishers = yield* Ref.make<Finishers>(new Map());
    yield* Effect.gen(function* () {
      yield* boot;
      const task = yield* delegate("nested-original");
      const childId = task.childThreadId!;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain(30);
      const initial = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
      yield* finishRun(finishers, initial, "completed", "Original nested result.");
      yield* orchestrator.recoverDelegatedTask(childId, initial.id);
      yield* humanFollowup(childId, "owns-descendant");
      yield* worker.drain(30);
      const second = (yield* orchestrator.getThreadProjection(childId)).runs[1]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("nested-live"),
        parentThreadId: childId,
        parentRunId: second.id,
        parentNodeId: second.rootNodeId!,
        task: "Nested work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "settled_only",
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* humanFollowup(childId, "removed-independent-task");
      const third = (yield* orchestrator.getThreadProjection(childId)).runs[2]!;
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("remove-independent-task"),
        threadId: childId,
        runId: third.id,
      });
      yield* orchestrator.recoverDelegatedTask(childId, third.id);
      const cancelled = yield* taskStatus(third.delegatedTaskId!);
      assert.deepEqual(
        { status: cancelled.status, summary: cancelled.summary },
        { status: "cancelled", summary: "Child task ended with status cancelled." },
      );
      const child = yield* orchestrator.getThreadProjection(childId);
      assert.equal(child.subagents[0]?.runId, second.id);
      assert.equal(child.subagents[0]?.result, null);
      assert.equal((yield* taskStatus(second.delegatedTaskId!)).status, "running");
      assert.equal((yield* taskStatus(task.id)).summary, "Original nested result.");
      yield* finishRun(finishers, second, "completed", "Waiting for nested work.");
      const descendantId = child.subagents[0]!.childThreadId!;
      const descendantRun = (yield* orchestrator.getThreadProjection(descendantId)).runs[0]!;
      const sink = yield* EventSink.EventSinkV2;
      const delivered = yield* Deferred.make<void>();
      const deliveryWatcher = yield* sink
        .stream({ threadId: childId, eventType: "message.updated" })
        .pipe(
          Stream.runForEach((stored) =>
            stored.event.type === "message.updated" &&
            stored.event.payload.delegatedCompletion?.parentRunId === second.id
              ? Deferred.succeed(delivered, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkChild,
        );
      yield* finishRun(finishers, descendantRun, "completed", "Nested work result.");
      yield* Deferred.await(delivered);
      yield* worker.drain(30);
      const resumedChild = yield* orchestrator.getThreadProjection(childId);
      const wake = resumedChild.runs.find(
        (run) => run.ordinal > third.ordinal && run.status === "running",
      );
      assert.deepEqual(
        resumedChild.runs
          .map((run) => ({ ordinal: run.ordinal, status: run.status, owner: run.delegatedTaskId }))
          .at(-1),
        { ordinal: 4, status: "running", owner: second.delegatedTaskId },
      );
      if (wake === undefined) return yield* Effect.die("Completion wake did not start");
      assert.equal(wake.delegatedTaskId, second.delegatedTaskId);
      yield* finishRun(finishers, wake, "completed", "Second nested final result.");
      yield* orchestrator.recoverDelegatedTask(childId, wake.id);
      assert.equal(
        (yield* taskStatus(second.delegatedTaskId!)).summary,
        "Second nested final result.",
      );
      assert.equal((yield* taskStatus(task.id)).summary, "Original nested result.");
      assert.equal((yield* taskStatus(third.delegatedTaskId!)).status, "cancelled");
      yield* Fiber.interrupt(deliveryWatcher);
    }).pipe(
      Effect.provide(controlledSwarmLayer({ turns, finishers, runContinuationWorker: true })),
    );
  }),
);

it.effect.each([{ kind: "background_task" }, { kind: "monitor" }] as const)(
  "r3 cancelled unstarted task does not borrow another task's native $kind roster",
  ({ kind }) =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const finishers = yield* Ref.make<Finishers>(new Map());
      const providerEvents = yield* Ref.make<ProviderEvents>(new Map());
      yield* Effect.gen(function* () {
        yield* boot;
        const task = yield* delegate("native-original");
        const childId = task.childThreadId!;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain(30);
        const initial = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
        yield* finishRun(finishers, initial, "completed", "Original native result.");
        yield* orchestrator.recoverDelegatedTask(childId, initial.id);
        yield* humanFollowup(childId, "native-owner-A");
        yield* worker.drain(30);
        const second = (yield* orchestrator.getThreadProjection(childId)).runs[1]!;
        const providerThreadId = yield* publishBackground(providerEvents, second, [
          { taskId: "A-native-work", kind },
        ]);
        yield* humanFollowup(childId, "unstarted-B");
        const third = (yield* orchestrator.getThreadProjection(childId)).runs[2]!;
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("remove-native-B"),
          threadId: childId,
          runId: third.id,
        });
        yield* finishRun(finishers, second, "completed", "A completed its root turn.");
        yield* orchestrator.recoverDelegatedTask(childId, third.id);
        const cancelled = yield* taskStatus(third.delegatedTaskId!);
        assert.deepEqual(
          { status: cancelled.status, summary: cancelled.summary },
          { status: "cancelled", summary: "Child task ended with status cancelled." },
        );
        const a = yield* taskStatus(second.delegatedTaskId!);
        assert.equal(a.status, "running");
        assert.equal(a.summary, null);
        const child = yield* orchestrator.getThreadProjection(childId);
        assert.equal(child.runs.find((run) => run.id === third.id)?.startedAt, null);
        assert.deepEqual(
          child.providerThreads.find((thread) => thread.id === providerThreadId)
            ?.pendingBackgroundTasks,
          [{ taskId: "A-native-work", kind }],
        );
        assert.deepEqual(
          delegatedTaskProgressForTask(child, second.delegatedTaskId!).backgroundScope,
          { kind: "shared_provider_thread", providerThreadIds: [providerThreadId] },
        );
        assert.deepEqual(
          delegatedTaskProgressForTask(child, third.delegatedTaskId!).backgroundScope,
          { kind: "none" },
        );
        yield* publishBackground(providerEvents, second, []);
        yield* worker.drain(30);
        yield* orchestrator.recoverDelegatedTask(childId, second.id);
        const clearedChild = yield* orchestrator.getThreadProjection(childId);
        const completedA = yield* taskStatus(second.delegatedTaskId!);
        assert.deepEqual(
          {
            summary: completedA.summary,
            state: completedA.workState,
            runStatus: clearedChild.runs.find((run) => run.id === second.id)?.status,
            roster: clearedChild.providerThreads.find((thread) => thread.id === providerThreadId)
              ?.pendingBackgroundTasks,
          },
          {
            summary: "A completed its root turn.",
            state: "result_available",
            runStatus: "completed",
            roster: [],
          },
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("native-monitor-note"),
          threadId: childId,
          messageId: MessageId.make("native-monitor-note"),
          text: "Monitor observation",
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          dispatchMode: { type: "queue_after_active" },
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "Monitor observation",
          },
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("resume-native-monitor"),
          threadId: childId,
        });
        yield* worker.drain(30);
        const monitor = (yield* orchestrator.getThreadProjection(childId)).runs.at(-1)!;
        yield* finishRun(finishers, monitor, "completed", "Monitor acknowledgement.");
        yield* orchestrator.recoverDelegatedTask(childId, monitor.id);
        assert.equal(
          (yield* taskStatus(second.delegatedTaskId!)).summary,
          "A completed its root turn.",
        );
        assert.equal((yield* taskStatus(task.id)).summary, "Original native result.");
        assert.equal((yield* taskStatus(third.delegatedTaskId!)).status, "cancelled");
      }).pipe(Effect.provide(controlledSwarmLayer({ turns, finishers, providerEvents })));
    }),
);

it.effect(
  "r3 a generic initial task stopped before provider acceptance publishes its own interruption",
  () =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      yield* Effect.gen(function* () {
        yield* boot;
        const task = yield* delegate("never-started-original");
        const childId = task.childThreadId!;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const initial = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
        assert.equal(initial.startedAt, null);
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("cancel-initial"),
          threadId: childId,
        });
        yield* orchestrator.recoverDelegatedTask(childId, initial.id);
        const result = yield* taskStatus(task.id);
        assert.deepEqual(
          { status: result.status, summary: result.summary, childRunId: result.childRunId },
          {
            status: "interrupted",
            summary: "Child task ended with status interrupted.",
            childRunId: initial.id,
          },
        );
      }).pipe(Effect.provide(controlledSwarmLayer({ turns })));
    }),
);

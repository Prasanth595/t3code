import { assert, it } from "@effect/vitest";
import { CommandId, MessageId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import {
  boot,
  controlledSwarmLayer,
  create,
  humanFollowup,
  modelSelection,
  ownerId,
} from "./SwarmTestFixture.ts";
import { type Finishers, delegate, finishRun, taskStatus } from "./DelegatedTaskTestFixture.ts";

it.effect.each([
  { mode: "open" },
  { mode: "raised" },
  { mode: "stopped" },
  { mode: "sender-stopped" },
] as const)(
  "r3 delegated peer completion retains captured authorization and host attribution in $mode mode",
  ({ mode }) =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const finishers = yield* Ref.make<Finishers>(new Map());
      yield* Effect.gen(function* () {
        yield* boot;
        const { group } = yield* create();
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        for (const id of [ownerId, ...group.members.map((member) => member.threadId)]) {
          yield* orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make(`low-runtime:${id}`),
            threadId: id,
            runtimeMode: "approval-required",
          });
          yield* orchestrator.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make(`low-interaction:${id}`),
            threadId: id,
            interactionMode: "plan",
          });
        }
        yield* worker.drain(30);
        const sender = (yield* orchestrator.getThreadProjection(group.members[0]!.threadId))
          .runs[0]!;
        const childId = group.members[1]!.threadId;
        const original = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
        yield* finishRun(finishers, original, "completed", "Original member result.");
        yield* orchestrator.recoverDelegatedTask(childId, original.id);
        yield* orchestrator.dispatch({
          type: "swarm.send",
          commandId: CommandId.make("low-peer"),
          intentFingerprint: "low-peer",
          threadId: childId,
          swarmId: group.id,
          senderThreadId: sender.threadId,
          senderRunId: sender.id,
          text: "Delegate a low-mode child.",
          runtimeMode: "approval-required",
          interactionMode: "plan",
        });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("start-low-peer"),
          threadId: childId,
        });
        yield* worker.drain(30);
        const peerRun = (yield* orchestrator.getThreadProjection(childId)).runs[1]!;
        const peerInput = (yield* Ref.get(turns)).find((turn) => turn.runId === peerRun.id)!;
        assert.deepEqual(
          [peerInput.runtimePolicy.runtimeMode, peerInput.runtimePolicy.interactionMode],
          ["approval-required", "plan"],
        );
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("low-descendant"),
          parentThreadId: childId,
          parentRunId: peerRun.id,
          parentNodeId: peerRun.rootNodeId!,
          task: "Low-mode nested work",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain(30);
        const nested = (yield* orchestrator.getThreadProjection(childId)).subagents[0]!;
        const nestedRun = (yield* orchestrator.getThreadProjection(nested.childThreadId!)).runs[0]!;
        yield* finishRun(finishers, peerRun, "completed", "Wait for the nested result.");
        yield* finishRun(finishers, nestedRun, "completed", "Nested low-mode result.");
        yield* orchestrator.recoverDelegatedTask(nested.childThreadId!, nestedRun.id);
        const source = (yield* orchestrator.getThreadProjection(childId)).runs.find(
          (run) => run.id === peerRun.id,
        )!;
        const delivery = source.delegatedCompletion!.delivery!;
        if (mode === "raised") {
          yield* orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("raise-recipient-runtime"),
            threadId: childId,
            runtimeMode: "full-access",
          });
          yield* orchestrator.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("raise-recipient-interaction"),
            threadId: childId,
            interactionMode: "default",
          });
        }
        if (mode === "stopped")
          yield* orchestrator.dispatch({
            type: "swarm.stop",
            commandId: CommandId.make("stop-causal-group"),
            threadId: ownerId,
            swarmId: group.id,
            intentFingerprint: "stop-causal-group",
          });
        if (mode === "sender-stopped")
          yield* orchestrator.dispatch({
            type: "swarm.stop",
            commandId: CommandId.make("stop-causal-sender"),
            threadId: ownerId,
            swarmId: group.id,
            memberThreadId: sender.threadId,
            intentFingerprint: "stop-causal-sender",
          });
        const before = (yield* Ref.get(turns)).filter((turn) => turn.threadId === childId).length;
        const result = yield* Effect.exit(
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("host-completion"),
            threadId: childId,
            messageId: delivery.messageId,
            text: "Host-generated nested result.",
            attachments: [],
            createdBy: "agent",
            creationSource: "server",
            dispatchMode: { type: "queue_after_active" },
            notification: {
              source: {
                kind: "delegated_task",
                taskIds: delivery.taskIds,
                childThreadId: nested.childThreadId!,
              },
              outcome: "completed",
              summary: "Host-generated nested result.",
            },
            delegatedCompletion: {
              parentRunId: source.id,
              generation: delivery.generation,
              taskIds: delivery.taskIds,
            },
          }),
        );
        if (mode !== "open") {
          if (Exit.isSuccess(result))
            yield* orchestrator.dispatch({
              type: "queue.resume",
              commandId: CommandId.make("start-refused-host"),
              threadId: childId,
            });
          yield* worker.drain(30);
          const unauthorizedWake = (yield* Ref.get(turns))
            .filter((turn) => turn.threadId === childId)
            .slice(before);
          assert.deepEqual(
            unauthorizedWake.map((turn) => [
              turn.runtimePolicy.runtimeMode,
              turn.runtimePolicy.interactionMode,
            ]),
            [],
          );
          assert.isTrue(Exit.isFailure(result));
          assert.equal(
            (yield* Ref.get(turns)).filter((turn) => turn.threadId === childId).length,
            before,
          );
          assert.equal(
            (yield* orchestrator.getThreadProjection(childId)).messages.some(
              (message) => message.id === delivery.messageId,
            ),
            false,
          );
          return;
        }
        assert.isTrue(Exit.isSuccess(result));
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("start-host-completion"),
          threadId: childId,
        });
        yield* worker.drain(30);
        const child = yield* orchestrator.getThreadProjection(childId);
        const wake = child.runs.at(-1)!;
        const wakeInput = (yield* Ref.get(turns)).find((turn) => turn.runId === wake.id)!;
        assert.deepEqual(
          [wakeInput.runtimePolicy.runtimeMode, wakeInput.runtimePolicy.interactionMode],
          ["approval-required", "plan"],
        );
        assert.equal(wake.executionScope.kind, "swarm");
        if (wake.executionScope.kind === "swarm")
          assert.equal(wake.executionScope.swarmId, group.id);
        assert.deepEqual(wake.executionScope, peerRun.executionScope);
        assert.equal(wake.peerInput, undefined);
        assert.equal(wake.delegatedTaskId, peerRun.delegatedTaskId);
        const message = child.messages.find((row) => row.id === delivery.messageId)!;
        assert.equal(message.swarmPeerDelivery, undefined);
        assert.equal(message.senderThreadId, undefined);
        assert.equal(
          wakeInput.message.text,
          `Delegated task ${nested.id} reached a terminal state. Use task_status with taskId ${nested.id} to read the result.`,
        );
        const hostInputs = child.turnItems.flatMap((item) =>
          item.type === "notification" && item.runId === wake.id ? [item] : [],
        );
        assert.equal(hostInputs.length, 1);
        assert.equal(hostInputs[0]?.source.kind, "delegated_task");
        assert.notProperty(hostInputs[0], "swarmPeerDelivery");
        yield* finishRun(finishers, wake, "completed", "Scoped nested result consumed.");
        yield* orchestrator.recoverDelegatedTask(childId, wake.id);
        assert.equal(
          (yield* taskStatus(peerRun.delegatedTaskId!)).summary,
          "Scoped nested result consumed.",
        );
        assert.equal(
          (yield* taskStatus(group.members[1]!.taskId)).summary,
          "Original member result.",
        );
      }).pipe(Effect.provide(controlledSwarmLayer({ turns, finishers })));
    }),
);

it.effect.each([{ kind: "manual" }, { kind: "usage-limit" }] as const)(
  "r3 $kind continuation preserves a distinct unpublished followup task",
  ({ kind }) =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const finishers = yield* Ref.make<Finishers>(new Map());
      yield* Effect.gen(function* () {
        yield* boot;
        const original = yield* delegate("continuation-original");
        const childId = original.childThreadId!;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain(30);
        const first = (yield* orchestrator.getThreadProjection(childId)).runs[0]!;
        yield* finishRun(finishers, first, "completed", "Original immutable result.");
        yield* orchestrator.recoverDelegatedTask(childId, first.id);
        yield* humanFollowup(childId, "distinct-continuation-task");
        yield* worker.drain(30);
        const second = (yield* orchestrator.getThreadProjection(childId)).runs[1]!;
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("continuation-child"),
          parentThreadId: childId,
          parentRunId: second.id,
          parentNodeId: second.rootNodeId!,
          task: "Hold the task's nested work",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "settled_only",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* worker.drain(30);
        if (kind === "manual")
          yield* finishRun(finishers, second, "interrupted", "Interrupted source.");
        else {
          yield* finishRun(finishers, second, "failed", "Quota source.", {
            class: "usage_limit",
            code: "quota",
            message: "Quota source.",
            retryable: null,
            resetAt: "1970-01-01T00:01:00.000Z",
          });
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("arm-limit-recovery"),
            threadId: childId,
            limitRecovery: {
              runId: second.id,
              resetAt: "1970-01-01T00:01:00.000Z",
              autoResume: true,
            },
          });
          yield* TestClock.adjust("1 minute");
        }
        const recovery = (yield* orchestrator.getThreadProjection(childId)).thread.limitRecovery;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("continue-distinct-task"),
          threadId: childId,
          messageId: MessageId.make("continue-distinct-task"),
          text: "Continue distinct work.",
          attachments: [],
          createdBy: kind === "manual" ? "user" : "agent",
          creationSource: kind === "manual" ? "web" : "server",
          dispatchMode: { type: "start_immediately" },
          ...(kind === "manual"
            ? { manualContinuationOfRunId: second.id }
            : {
                usageLimitContinuationOfRunId: second.id,
                usageLimitRecoveryRequestId: recovery!.requestId,
              }),
        });
        yield* worker.drain(30);
        const resumed = (yield* orchestrator.getThreadProjection(childId)).runs[2]!;
        assert.equal(resumed.status, "running");
        assert.equal(resumed.delegatedTaskId, second.delegatedTaskId);
        assert.notEqual(resumed.delegatedTaskId, original.id);
        const parent = yield* orchestrator.getThreadProjection(ownerId);
        assert.equal(parent.subagents.length, 2);
        assert.equal(
          parent.subagents.find((task) => task.id === second.delegatedTaskId)?.result,
          null,
        );
        assert.equal((yield* taskStatus(original.id)).summary, "Original immutable result.");
      }).pipe(Effect.provide(controlledSwarmLayer({ turns, finishers })));
    }),
);

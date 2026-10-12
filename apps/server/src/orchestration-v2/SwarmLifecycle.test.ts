import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Stream from "effect/Stream";

import {
  modelSelection,
  layerTest,
  ownerId,
  boot,
  create,
  peer,
  humanFollowup,
  completeProjectedRun,
} from "./SwarmTestFixture.ts";

it.effect.each([false, true])(
  "r2 group Stop removes both captured results with unrelated cohort work %s",
  (unrelated) =>
    Effect.gen(function* () {
      const { run } = yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      if (unrelated)
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("cohort-unrelated"),
          parentThreadId: ownerId,
          parentRunId: run.id,
          parentNodeId: run.rootNodeId!,
          task: "Unrelated",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
      yield* humanFollowup(ownerId, "captured-wake");
      const parent = yield* orchestrator.getThreadProjection(ownerId);
      const wakeRun = parent.runs.at(-1)!;
      const wakeMessage = parent.messages.find((message) => message.id === wakeRun.userMessageId)!;
      const taskIds = parent.subagents.map((task) => task.id);
      const now = yield* DateTime.now;
      for (const task of parent.subagents)
        yield* store.apply({
          id: EventId.make(`claimed:${task.id}`),
          type: "subagent.updated",
          threadId: ownerId,
          occurredAt: now,
          payload: {
            ...task,
            status: "completed",
            result: `Result ${task.title}`,
            completedAt: now,
            completionDelivery: { state: "claimed", observedByRunId: null },
          },
        });
      yield* store.apply({
        id: EventId.make("cohort"),
        type: "run.updated",
        threadId: ownerId,
        occurredAt: now,
        payload: {
          ...parent.runs[0]!,
          delegatedCompletion: {
            disposition: "open",
            nextGeneration: 2,
            delivery: { generation: 1, messageId: wakeMessage.id, taskIds },
          },
        },
      });
      yield* store.apply({
        id: EventId.make("wake"),
        type: "message.updated",
        threadId: ownerId,
        occurredAt: now,
        payload: {
          ...wakeMessage,
          delegatedCompletion: { parentRunId: run.id, generation: 1, taskIds },
        },
      });
      const result = yield* orchestrator.dispatch({
        type: "swarm.stop",
        commandId: CommandId.make("cut-cohort"),
        threadId: ownerId,
        swarmId: group.id,
        intentFingerprint: "cut-cohort",
      });
      const after = yield* orchestrator.getThreadProjection(ownerId);
      const remaining = taskIds.filter(
        (id) => !group.members.some((member) => member.taskId === id),
      );
      assert.deepEqual(
        after.subagents
          .filter((task) => group.members.some((member) => member.taskId === task.id))
          .map((task) => task.completionDelivery?.state),
        ["disposed", "disposed"],
      );
      assert.deepEqual(after.runs[0]?.delegatedCompletion?.delivery?.taskIds ?? [], remaining);
      assert.equal(
        after.runs.find((candidate) => candidate.id === wakeRun.id)?.status,
        unrelated ? "queued" : "cancelled",
      );
      const message = after.messages.find((candidate) => candidate.id === wakeMessage.id)!;
      if (unrelated) {
        assert.deepEqual(message.delegatedCompletion?.taskIds, remaining);
        assert.include(message.text, remaining[0]!);
        for (const member of group.members) assert.notInclude(message.text, member.taskId);
      }
      assert.equal(
        result.storedEvents.filter((stored) => {
          const event = stored.event;
          return (
            event.type === "subagent.updated" &&
            group.members.some((member) => member.taskId === event.payload.id) &&
            event.payload.completionDelivery?.state === "disposed"
          );
        }).length,
        2,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "r2 human selected member Stop captures queue-only work and preserves later human work on replay",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const member = group.members[0]!;
      yield* peer(group, 1, 0, "queued-only-peer");
      const before = yield* orchestrator.getThreadProjection(member.threadId);
      yield* completeProjectedRun(member.threadId, before.runs[0]!.id, "failed", "failed");
      const cut = {
        threadId: ownerId,
        swarmId: group.id,
        memberThreadId: member.threadId,
        commandId: CommandId.make("human-member-cut"),
      };
      yield* threads.stopSwarm(cut);
      const stopped = yield* orchestrator.getThreadProjection(member.threadId);
      assert.equal(stopped.runs.at(-1)?.queueHeld, true);
      assert.deepEqual(
        (yield* threads.getSwarm(group.id))?.members.map((row) => row.admission.state),
        ["revoked", "admitted"],
      );
      assert.equal((yield* threads.getSwarm(group.id))?.lifecycle.state, "open");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(peer(group, 1, 0, "refused-revoked"))));
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("later-human-cut"),
        threadId: member.threadId,
        messageId: MessageId.make("later-human-cut"),
        text: "Later human",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const later = (yield* orchestrator.getThreadProjection(member.threadId)).runs.at(-1)!;
      yield* threads.stopSwarm(cut);
      assert.equal(
        (yield* orchestrator.getThreadProjection(member.threadId)).runs.at(-1)?.status,
        "starting",
      );
      yield* threads.stopSwarm({
        ...cut,
        memberThreadId: undefined,
        commandId: CommandId.make("close-group-after-member"),
      });
      assert.equal((yield* threads.getSwarm(group.id))?.lifecycle.state, "closed");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("human-closed-member"),
        threadId: member.threadId,
        messageId: MessageId.make("human-closed-member"),
        text: "Explicit human",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const newest = (yield* orchestrator.getThreadProjection(member.threadId)).runs.at(-1)!;
      yield* threads.stopSwarm({
        ...cut,
        memberThreadId: undefined,
        commandId: CommandId.make("closed-group-idempotent"),
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(member.threadId)).runs.at(-1)?.status,
        "starting",
      );
      yield* threads.stopSwarm({
        ...cut,
        commandId: CommandId.make("fresh-selected-closed-member"),
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(member.threadId)).runs.at(-1)?.status,
        "interrupted",
      );
      assert.deepEqual(
        yield* sql`SELECT status FROM orchestration_v2_effect_outbox WHERE effect_type = 'provider-turn.start' AND json_extract(payload_json, '$.runId') = ${newest.id}`,
        [{ status: "cancelled" }],
      );
      assert.notEqual(later.id, newest.id);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            threads.stopSwarm({
              ...cut,
              memberThreadId: ownerId,
              commandId: CommandId.make("invalid-selected-member"),
            }),
          ),
        ),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "r2 human selected member Stop captures descendant-only work through the public service",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const member = group.members[0]!;
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(1);
      yield* (yield* EventSink.EventSinkV2)
        .stream({ threadId: member.threadId, eventType: "provider-turn.updated", afterSequence: 0 })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
        );
      const child = yield* orchestrator.getThreadProjection(member.threadId);
      const run = child.runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("selected-descendant"),
        parentThreadId: member.threadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Selected descendant",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const descendant = (yield* orchestrator.getThreadProjection(member.threadId)).subagents[0]!;
      yield* completeProjectedRun(member.threadId, run.id, "Member finished");
      yield* threads.stopSwarm({
        threadId: ownerId,
        swarmId: group.id,
        memberThreadId: member.threadId,
        commandId: CommandId.make("cut-descendant-only"),
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(descendant.childThreadId!)).runs[0]?.status,
        "interrupted",
      );
      assert.equal(
        (yield* orchestrator.getThreadProjection(group.members[1]!.threadId)).runs[0]?.status,
        "starting",
      );
      assert.deepEqual(
        (yield* threads.getSwarm(group.id))?.members.map((row) => row.admission.state),
        ["revoked", "admitted"],
      );
      assert.equal((yield* threads.getSwarm(group.id))?.lifecycle.state, "open");
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "Stop closes admission and a delayed parent cascade preserves later ordinary member work",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* peer(group, 0, 1, "pre-stop");
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("parent-stop"),
        threadId: ownerId,
      });
      assert.equal((yield* orchestrator.getSwarm(group.id))?.lifecycle.state, "closed");
      const target = group.members[1]!.threadId;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("human-after-stop"),
        threadId: target,
        messageId: MessageId.make("human-after-stop"),
        text: "New ordinary work",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const delayed = yield* Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        yield* threads.stopDelegatedTasks({
          threadId: ownerId,
          commandId: CommandId.make("parent-stop"),
        });
      }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(delayed);
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(20);
      yield* (yield* EventSink.EventSinkV2)
        .stream({ threadId: target, eventType: "run.updated", afterSequence: 0 })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.userMessageId === MessageId.make("human-after-stop") &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
        );
      const child = yield* orchestrator.getThreadProjection(target);
      assert.equal(child.runs.at(-1)?.status, "running");
      assert.deepEqual(child.runs.at(-1)?.executionScope, { kind: "ordinary" });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(peer(group, 1, 0, "post-stop"))));
    }).pipe(Effect.provide(layerTest)),
);

it.effect("stale agent owner Stop refuses while trusted human idle Stop succeeds", () =>
  Effect.gen(function* () {
    const { run } = yield* boot;
    const { group } = yield* create();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* store.apply({
      type: "run.updated",
      id: EventId.make("owner-completed"),
      threadId: ownerId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          orchestrator.dispatch({
            type: "swarm.stop",
            commandId: CommandId.make("stale-agent-stop"),
            threadId: ownerId,
            swarmId: group.id,
            agentOwnerRunId: run.id,
            intentFingerprint: "stale",
          }),
        ),
      ),
    );
    yield* (yield* ThreadManagement.ThreadManagementService).stopSwarm({
      commandId: CommandId.make("human-idle-stop"),
      threadId: ownerId,
      swarmId: group.id,
    });
    assert.equal((yield* orchestrator.getSwarm(group.id))?.lifecycle.state, "closed");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("group Stop preserves unrelated work and member Stop revokes only that address", () =>
  Effect.gen(function* () {
    const { run } = yield* boot;
    const { group } = yield* create();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make("unrelated"),
      parentThreadId: ownerId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task: "Unrelated",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const unrelated = (yield* orchestrator.getThreadProjection(ownerId)).subagents.find(
      (task) => task.prompt === "Unrelated",
    )!;
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("member-stop"),
      threadId: group.members[0]!.threadId,
    });
    assert.deepEqual(
      (yield* orchestrator.getSwarm(group.id))?.members.map((member) => member.admission.state),
      ["revoked", "admitted"],
    );
    assert.equal((yield* orchestrator.getSwarm(group.id))?.lifecycle.state, "open");
    yield* orchestrator.dispatch({
      type: "swarm.stop",
      commandId: CommandId.make("group-only-stop"),
      threadId: ownerId,
      swarmId: group.id,
      intentFingerprint: "stop",
    });
    assert.equal(
      (yield* orchestrator.getThreadProjection(unrelated.childThreadId!)).runs[0]?.status,
      "starting",
    );
    const owner = yield* orchestrator.getThreadProjection(ownerId);
    assert.equal(owner.runs[0]?.status, "running");
    assert.equal(
      owner.subagents.find((task) => task.id === unrelated.id)?.completionDelivery?.state,
      undefined,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "deletion closes owner admission and byte bounds refuse without materializing peer input",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const refused = yield* Effect.exit(
        peer(group, 0, 1, "utf8-overflow", String.fromCharCode(233).repeat(8193)),
      );
      assert.isTrue(Exit.isFailure(refused));
      assert.equal(
        (yield* orchestrator.getThreadProjection(group.members[1]!.threadId)).messages.length,
        1,
      );
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete-owner"),
        threadId: ownerId,
      });
      assert.equal((yield* orchestrator.getSwarm(group.id))?.lifecycle.state, "closed");
      assert.deepEqual(
        (yield* orchestrator.getSwarm(group.id))?.members.map((member) => member.admission.state),
        ["revoked", "revoked"],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a descendant Stop preserves its member admission and disposes its own parent delivery",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(1);
      yield* (yield* EventSink.EventSinkV2)
        .stream({
          threadId: group.members[0]!.threadId,
          eventType: "provider-turn.updated",
          afterSequence: 0,
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
          ),
          Stream.runHead,
        );
      const member = yield* orchestrator.getThreadProjection(group.members[0]!.threadId);
      const run = member.runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("scoped-descendant"),
        parentThreadId: member.thread.id,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Descendant",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const childTask = (yield* orchestrator.getThreadProjection(member.thread.id)).subagents[0]!;
      const childId = childTask.childThreadId!;
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-descendant"),
        threadId: childId,
      });
      assert.deepEqual(
        (yield* orchestrator.getSwarm(group.id))?.members.map((row) => row.admission.state),
        ["admitted", "admitted"],
      );
      assert.equal(
        (yield* orchestrator.getThreadProjection(member.thread.id)).runs[0]?.status,
        "running",
      );
      assert.equal(
        (yield* orchestrator.getThreadProjection(member.thread.id)).subagents[0]?.completionDelivery
          ?.state,
        "disposed",
      );
    }).pipe(Effect.provide(layerTest)),
);

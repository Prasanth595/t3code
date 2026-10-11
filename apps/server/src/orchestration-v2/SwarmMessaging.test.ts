import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProviderInstanceId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";

import {
  layerTest,
  decodeCommand,
  ownerId,
  boot,
  create,
  peer,
  humanFollowup,
  completeProjectedRun,
} from "./SwarmTestFixture.ts";

it.effect.each([
  { creationSource: "web", initialStatus: "completed" },
  { creationSource: "web", initialStatus: "failed" },
  { creationSource: "mcp", initialStatus: "completed" },
  { creationSource: "mcp", initialStatus: "failed" },
] as const)(
  "r2 ordinary $creationSource followup publishes its result after $initialStatus original work",
  ({ creationSource, initialStatus }) =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const member = group.members[0]!;
      yield* humanFollowup(member.threadId, "follow-up result", creationSource);
      const child = yield* orchestrator.getThreadProjection(member.threadId);
      yield* completeProjectedRun(
        member.threadId,
        child.runs[0]!.id,
        "initial result",
        initialStatus,
      );
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-followup"),
        threadId: member.threadId,
      });
      const promoted = (yield* orchestrator.getThreadProjection(member.threadId)).runs.at(-1)!;
      assert.equal(promoted.status, "starting");
      yield* completeProjectedRun(member.threadId, promoted.id, "follow-up result");
      yield* orchestrator.recoverDelegatedTask(member.threadId, promoted.id);
      const parent = yield* orchestrator.getThreadProjection(ownerId);
      const task = parent.subagents.find((candidate) => candidate.id === member.taskId)!;
      assert.equal(task.status, "completed");
      assert.equal(task.result, "follow-up result");
      assert.equal(child.runs.at(-1)?.delegatedTaskId, member.taskId);
      assert.equal(promoted.delegatedTaskId, member.taskId);
      assert.equal(
        parent.contextTransfers.find(
          (transfer) =>
            transfer.type === "subagent_result" && transfer.sourceThreadId === member.threadId,
        )?.sourcePoint.runId,
        promoted.id,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "reciprocal queued sends retain real provenance, bounded queues and attribution edit refusal",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* Effect.all([peer(group, 0, 1, "a-to-b"), peer(group, 1, 0, "b-to-a")], {
        concurrency: 2,
      });
      const b = yield* orchestrator.getThreadProjection(group.members[1]!.threadId);
      const queued = b.runs.find((run) => run.status === "queued");
      assert.equal(b.messages.at(-1)?.senderThreadId, group.members[0]!.threadId);
      assert.equal(queued?.delegatedTaskId, group.members[1]!.taskId);
      assert.deepEqual(
        [
          (yield* orchestrator.getThreadShell(b.thread.id))?.queuedMessageCount,
          (yield* orchestrator.getThreadShell(b.thread.id))?.heldQueuedMessageCount,
        ],
        [1, 0],
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              type: "queued-run.edit",
              threadId: b.thread.id,
              commandId: CommandId.make("edit-peer"),
              runId: queued!.id,
              text: "Forged",
            }),
          ),
        ),
      );
      for (let index = 1; index < 16; index++) yield* peer(group, 0, 1, `bounded-${index}`);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(peer(group, 0, 1, "overflow"))));
      assert.equal((yield* orchestrator.getThreadShell(b.thread.id))?.queuedMessageCount, 16);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "held queued input rebinds after publication and replies to a terminal peer with fresh owner accounting",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* peer(group, 0, 1, "question", "/compact");
      const parent = yield* orchestrator.getThreadProjection(ownerId);
      const now = yield* DateTime.now;
      const events = [];
      for (const member of group.members) {
        const child = yield* orchestrator.getThreadProjection(member.threadId);
        const original = child.runs[0]!;
        const task = parent.subagents.find((row) => row.id === member.taskId)!;
        events.push({
          id: EventId.make(`published-${member.title}`),
          type: "subagent.updated" as const,
          threadId: ownerId,
          occurredAt: now,
          payload: {
            ...task,
            result: `Original ${member.title}`,
            status: "completed" as const,
            completedAt: now,
            updatedAt: now,
          },
        });
        for (const run of child.runs)
          events.push({
            id: EventId.make(`held-${run.id}`),
            type: "run.updated" as const,
            threadId: child.thread.id,
            runId: run.id,
            occurredAt: now,
            payload:
              run.id === original.id
                ? { ...run, status: "failed" as const, completedAt: now }
                : { ...run, queueHeld: true },
          });
      }
      yield* sink.write({ events });
      const bId = group.members[1]!.threadId;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-b"),
        threadId: bId,
      });
      const b = yield* orchestrator.getThreadProjection(bId);
      const rebound = b.runs.at(-1)!;
      assert.equal(rebound.status, "starting");
      assert.notEqual(rebound.delegatedTaskId, group.members[1]!.taskId);
      const after = yield* orchestrator.getThreadProjection(ownerId);
      assert.equal(
        after.subagents.find((row) => row.id === group.members[1]!.taskId)?.result,
        "Original B",
      );
      assert.equal(after.nodes.find((row) => row.id === rebound.delegatedTaskId)?.kind, "subagent");
      assert.equal(
        after.turnItems.find(
          (row) => row.type === "subagent" && row.subagentId === rebound.delegatedTaskId,
        )?.type,
        "subagent",
      );
      yield* peer(group, 1, 0, "reply", "Answer");
      const a = yield* orchestrator.getThreadProjection(group.members[0]!.threadId);
      assert.equal(a.messages.at(-1)?.senderThreadId, bId);
      assert.notEqual(a.runs.at(-1)?.delegatedTaskId, group.members[0]!.taskId);
      assert.equal(
        (yield* orchestrator.getThreadProjection(ownerId)).subagents.find(
          (row) => row.id === group.members[0]!.taskId,
        )?.result,
        "Original A",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("raw message command decoding strips forged peer provenance", () =>
  Effect.gen(function* () {
    yield* boot;
    const { group } = yield* create();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const command = decodeCommand({
      type: "message.dispatch",
      commandId: "raw-human",
      threadId: group.members[0]!.threadId,
      messageId: "raw-human",
      text: "Ordinary",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "queue_after_active" },
      swarmId: group.id,
      swarmPeerDelivery: {
        swarmId: group.id,
        ownerThreadId: ownerId,
        senderThreadId: group.members[1]!.threadId,
        commandId: "spoof",
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    });
    yield* orchestrator.dispatch(command);
    const child = yield* orchestrator.getThreadProjection(group.members[0]!.threadId);
    assert.equal(child.runs.at(-1)?.swarmId, undefined);
    assert.equal(child.messages.at(-1)?.swarmPeerDelivery, undefined);
    assert.equal(child.messages.at(-1)?.text, "Ordinary");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "same-group authority refuses ordinary, cross-group, native and stale-provider callers",
  () =>
    Effect.gen(function* () {
      const { run } = yield* boot;
      const { group } = yield* create();
      const { group: other } = yield* create("other-group");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const source = yield* orchestrator.getThreadProjection(group.members[0]!.threadId);
      const base = {
        type: "swarm.send",
        commandId: CommandId.make("cross-group"),
        intentFingerprint: "cross",
        swarmId: group.id,
        senderThreadId: source.thread.id,
        senderRunId: source.runs[0]!.id,
        threadId: other.members[0]!.threadId,
        runtimeMode: "full-access",
        interactionMode: "default",
        text: "Refused",
      } satisfies OrchestrationV2ServerCommand;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(orchestrator.dispatch(base))));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              ...base,
              commandId: CommandId.make("ordinary-sender"),
              threadId: group.members[1]!.threadId,
              senderThreadId: ownerId,
              senderRunId: run.id,
            }),
          ),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              ...base,
              commandId: CommandId.make("stale-provider"),
              threadId: group.members[1]!.threadId,
              senderProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
            }),
          ),
        ),
      );
      const recipient = yield* orchestrator.getThreadProjection(group.members[1]!.threadId);
      yield* store.apply({
        id: EventId.make("native-destination"),
        type: "thread.metadata-updated",
        threadId: recipient.thread.id,
        occurredAt: yield* DateTime.now,
        payload: { ...recipient.thread, creationSource: "provider" },
      });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(peer(group, 0, 1, "native"))));
      assert.equal(
        (yield* orchestrator.getThreadProjection(recipient.thread.id)).messages.length,
        1,
      );
      assert.equal(
        (yield* orchestrator.getThreadProjection(other.members[0]!.threadId)).messages.length,
        1,
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("peer promotions refuse before steering in open, raised and closed states", () =>
  Effect.gen(function* () {
    yield* boot;
    const { group } = yield* create();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("promotion-lower"),
      threadId: group.members[1]!.threadId,
      runtimeMode: "approval-required",
    });
    yield* peer(group, 0, 1, "promotion-peer", "/compact");
    const b = yield* orchestrator.getThreadProjection(group.members[1]!.threadId);
    const queued = b.runs.at(-1)!;
    const command = {
      type: "queued-message.promote-to-steer",
      commandId: CommandId.make("open-promotion"),
      threadId: b.thread.id,
      queuedRunId: queued.id,
      targetRunId: b.runs[0]!.id,
    } satisfies OrchestrationV2ServerCommand;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(orchestrator.dispatch(command))));
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("promotion-raise"),
      threadId: b.thread.id,
      runtimeMode: "full-access",
    });
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          orchestrator.dispatch({ ...command, commandId: CommandId.make("raised-promotion") }),
        ),
      ),
    );
    yield* orchestrator.dispatch({
      type: "swarm.stop",
      commandId: CommandId.make("promotion-stop"),
      threadId: ownerId,
      swarmId: group.id,
      intentFingerprint: "stop",
    });
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          orchestrator.dispatch({ ...command, commandId: CommandId.make("closed-promotion") }),
        ),
      ),
    );
    const after = yield* orchestrator.getThreadProjection(b.thread.id);
    assert.equal(after.runs.at(-1)?.status, "queued");
    assert.equal(after.messages.at(-1)?.text, "/compact");
    assert.equal(after.messages.at(-1)?.senderThreadId, group.members[0]!.threadId);
  }).pipe(Effect.provide(layerTest)),
);

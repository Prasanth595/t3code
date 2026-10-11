import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { swarmRunAllowed } from "./SwarmAdmission.ts";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { type RunId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { vi } from "vite-plus/test";

import {
  layerTest,
  ownerId,
  boot,
  create,
  peer,
  controlledSwarmLayer,
  type SwarmTestFinisher,
} from "./SwarmTestFixture.ts";

it.effect(
  "r2 Stop during the final admission read cancels the captured in-flight start without a native prompt",
  () =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        yield* boot;
        const { group } = yield* create();
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sql = yield* SqlClient.SqlClient;
        const target = group.members[0]!.threadId;
        const originalGetSwarm = store.getSwarm;
        let pause = true;
        const spy = vi.spyOn(store, "getSwarm").mockImplementation((id) =>
          Effect.gen(function* () {
            const snapshot = yield* originalGetSwarm(id);
            if (
              pause &&
              id === group.id &&
              (yield* store.getThreadRecords(target, ["runs"])).runs[0]?.status === "running"
            ) {
              pause = false;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return snapshot;
          }),
        );
        const drain = yield* worker.drain(20).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const cut = {
          threadId: ownerId,
          swarmId: group.id,
          commandId: CommandId.make("r2-stop-final-read"),
        };
        yield* (yield* ThreadManagement.ThreadManagementService).stopSwarm(cut);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(drain);
        spy.mockRestore();
        assert.deepEqual(
          (yield* Ref.get(turns)).map((turn) => turn.threadId),
          [ownerId],
        );
        assert.deepEqual(
          (yield* store.getThreadRecords(target, ["runs"])).runs.map((run) => run.status),
          ["interrupted"],
        );
        assert.deepEqual(
          yield* sql`SELECT status FROM orchestration_v2_effect_outbox WHERE thread_id = ${target} AND effect_type = 'provider-turn.start'`,
          [{ status: "cancelled" }],
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("r2-deliberate-human"),
          threadId: target,
          messageId: MessageId.make("r2-deliberate-human"),
          text: "Later human",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        yield* (yield* ThreadManagement.ThreadManagementService).stopSwarm(cut);
        yield* worker.drain(20);
        const submitted = yield* Ref.get(turns);
        assert.deepEqual(
          submitted.map((turn) => [turn.threadId, turn.message.messageId]),
          [
            [ownerId, MessageId.make("owner-message")],
            [target, MessageId.make("r2-deliberate-human")],
          ],
        );
        assert.isTrue(submitted[1]!.message.text.endsWith("User message:\nLater human"));
        assert.equal(
          (yield* store.getThreadRecords(target, ["runs"])).runs.at(-1)?.status,
          "running",
        );
      }).pipe(Effect.provide(controlledSwarmLayer({ turns })));
    }),
);

it.effect("r2 setup mode downgrades reach the actual adapter policy boundary", () =>
  Effect.gen(function* () {
    const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let target: ThreadId | undefined;
    const beforeSetup = (threadId: ThreadId) =>
      threadId === target
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.asVoid,
          )
        : Effect.void;
    yield* Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      target = group.members[0]!.threadId;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const drain = yield* worker.drain(20).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      for (const threadId of [ownerId, ...group.members.map((member) => member.threadId)]) {
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`r2-low-runtime:${threadId}`),
          threadId,
          runtimeMode: "approval-required",
        });
        yield* orchestrator.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make(`r2-low-interaction:${threadId}`),
          threadId,
          interactionMode: "plan",
        });
      }
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(drain);
      assert.deepEqual(
        (yield* Ref.get(turns))
          .filter((turn) => turn.threadId !== ownerId)
          .map((turn) => [
            turn.threadId,
            turn.runtimePolicy.runtimeMode,
            turn.runtimePolicy.interactionMode,
          ]),
        group.members.map((member) => [member.threadId, "approval-required", "plan"]),
      );
    }).pipe(Effect.provide(controlledSwarmLayer({ turns, beforeSetup })));
  }),
);

it.effect(
  "r2 an accepted start publishes its exact Stop target before releasing the owner boundary",
  () =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let target: ThreadId | undefined;
      const beforeAcceptance = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
        turn.threadId === target
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.asVoid,
            )
          : Effect.void;
      yield* Effect.gen(function* () {
        yield* boot;
        const { group } = yield* create();
        target = group.members[0]!.threadId;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const drain = yield* worker.drain(20).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const stop = yield* (yield* ThreadManagement.ThreadManagementService)
          .stopSwarm({
            threadId: ownerId,
            swarmId: group.id,
            memberThreadId: target,
            commandId: CommandId.make("r2-stop-acceptance-winner"),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stop);
        yield* Fiber.join(drain);
        const native = (yield* Ref.get(turns)).find((turn) => turn.threadId === target)!;
        const sql = yield* SqlClient.SqlClient;
        assert.equal(native.message.text, "Work A");
        assert.deepEqual(
          yield* sql`SELECT json_extract(payload_json, '$.providerTurnId') AS target FROM orchestration_v2_effect_outbox WHERE command_id = 'r2-stop-acceptance-winner' AND effect_type = 'provider-turn.interrupt'`,
          [{ target: `turn:${native.runId}` }],
        );
        assert.deepEqual(
          (yield* (yield* Orchestrator.OrchestratorV2).getSwarm(group.id))?.members.map(
            (member) => member.admission.state,
          ),
          ["revoked", "admitted"],
        );
      }).pipe(Effect.provide(controlledSwarmLayer({ turns, beforeAcceptance })));
    }),
);

it.effect("r2 admission reads current recipient availability and checks the submitted policy", () =>
  Effect.gen(function* () {
    yield* boot;
    const { group } = yield* create();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const recipient = yield* orchestrator.getThreadProjection(group.members[0]!.threadId);
    const run = recipient.runs[0]!;
    assert.isTrue(yield* swarmRunAllowed(store, recipient.thread, run, recipient.thread));
    const now = yield* DateTime.now;
    yield* store.apply({
      id: EventId.make("r2-current-recipient-unavailable"),
      type: "thread.metadata-updated",
      threadId: recipient.thread.id,
      occurredAt: now,
      payload: { ...recipient.thread, archivedAt: now },
    });
    assert.isFalse(yield* swarmRunAllowed(store, recipient.thread, run, recipient.thread));
    yield* store.apply({
      id: EventId.make("r2-current-recipient-low"),
      type: "thread.metadata-updated",
      threadId: recipient.thread.id,
      occurredAt: now,
      payload: { ...recipient.thread, runtimeMode: "approval-required", interactionMode: "plan" },
    });
    assert.isFalse(yield* swarmRunAllowed(store, recipient.thread, run, recipient.thread));
    assert.isTrue(
      yield* swarmRunAllowed(store, recipient.thread, run, {
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "admission stores the lowered sender ceiling and delayed execution holds raised targets",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const { group } = yield* create();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      for (const threadId of [ownerId, ...group.members.map((member) => member.threadId)])
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`lower:${threadId}`),
          threadId,
          runtimeMode: "approval-required",
        });
      yield* peer(group, 0, 1, "lowered");
      const b = yield* orchestrator.getThreadProjection(group.members[1]!.threadId);
      const queued = b.runs.at(-1)!;
      assert.equal(queued.swarmPeerDelivery?.runtimeMode, "approval-required");
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise-b"),
        threadId: b.thread.id,
        runtimeMode: "full-access",
      });
      assert.equal(yield* swarmRunAllowed(store, b.thread, queued), false);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "initial delayed starts retain the captured owner ceiling and nested creation refuses",
  () =>
    Effect.gen(function* () {
      yield* boot;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("initial-low-owner"),
        threadId: ownerId,
        runtimeMode: "approval-required",
      });
      const { group, command } = yield* create("low-initial", "approval-required");
      const child = yield* orchestrator.getThreadProjection(group.members[0]!.threadId);
      assert.equal(child.runs[0]?.swarmRunAdmission?.runtimeMode, "approval-required");
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("initial-raised-owner"),
        threadId: ownerId,
        runtimeMode: "full-access",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("initial-raised-member"),
        threadId: child.thread.id,
        runtimeMode: "full-access",
      });
      assert.equal(yield* swarmRunAllowed(store, child.thread, child.runs[0]!), false);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              ...command,
              commandId: CommandId.make("nested-group"),
              threadId: child.thread.id,
              parentRunId: child.runs[0]!.id,
              parentNodeId: child.runs[0]!.rootNodeId!,
            }),
          ),
        ),
      );
      yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(20);
      const after = yield* orchestrator.getThreadProjection(child.thread.id);
      assert.equal(after.runs[0]?.status, "queued");
      assert.equal(after.runs[0]?.queueHeld, true);
      assert.equal(after.runs[0]?.delegatedTaskId, group.members[0]!.taskId);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "peer slash content reaches the provider and an old first Stop effect preserves later admitted human work",
  () =>
    Effect.gen(function* () {
      const turns = yield* Ref.make<ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>>([]);
      const initialStarts = yield* Deferred.make<void>();
      const peerStarted = yield* Deferred.make<void>();
      const finishers = yield* Ref.make<ReadonlyMap<RunId, SwarmTestFinisher>>(new Map());
      const interrupts = yield* Ref.make<ReadonlyArray<string>>([]);
      const liveLayer = controlledSwarmLayer({ turns, finishers, interrupts });
      yield* Effect.gen(function* () {
        yield* boot;
        const { group } = yield* create();
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sql = yield* SqlClient.SqlClient;
        let accepted = 0;
        const observer = yield* sink.stream({ eventType: "provider-turn.updated" }).pipe(
          Stream.runForEach((stored) =>
            Effect.gen(function* () {
              if (
                stored.event.type !== "provider-turn.updated" ||
                stored.event.payload.status !== "running"
              )
                return;
              accepted += 1;
              if (accepted >= 3) yield* Deferred.succeed(initialStarts, undefined);
              const captured = (yield* Ref.get(turns)).find(
                (turn) =>
                  turn.attemptId ===
                  (stored.event.type === "provider-turn.updated"
                    ? stored.event.payload.runAttemptId
                    : undefined),
              );
              if (captured?.message.text.includes("/compact"))
                yield* Deferred.succeed(peerStarted, undefined);
            }),
          ),
          Effect.forkChild,
        );
        yield* worker.drain(30);
        yield* Deferred.await(initialStarts);
        yield* peer(group, 0, 1, "live-question", "/compact");
        const target = group.members[1]!.threadId;
        const completeLatest = (settle = true) =>
          Effect.gen(function* () {
            const child = yield* orchestrator.getThreadProjection(target);
            const run = child.runs.findLast((row) => row.status === "running")!;
            const finish = (yield* Ref.get(finishers)).get(run.id);
            if (finish === undefined) return yield* Effect.die("Missing native finisher");
            const finalized = yield* Deferred.make<void>();
            const settled = yield* Deferred.make<void>();
            const nativeEnded = yield* Deferred.make<void>();
            const nativeWatcher = yield* sink
              .stream({ threadId: target, eventType: "provider-turn.updated" })
              .pipe(
                Stream.runForEach((stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.runAttemptId === run.activeAttemptId &&
                  stored.event.payload.status === "completed"
                    ? Deferred.succeed(nativeEnded, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
                Effect.forkChild,
              );
            const watcher = yield* sink.stream({ threadId: target, eventType: "run.updated" }).pipe(
              Stream.runForEach((stored) =>
                Effect.gen(function* () {
                  if (stored.event.type !== "run.updated" || stored.event.payload.id !== run.id)
                    return;
                  if (
                    ["waiting", "completed", "interrupted", "cancelled"].includes(
                      stored.event.payload.status,
                    )
                  )
                    yield* Deferred.succeed(finalized, undefined);
                  if (
                    ["completed", "interrupted", "cancelled"].includes(stored.event.payload.status)
                  )
                    yield* Deferred.succeed(settled, undefined);
                }),
              ),
              Effect.forkChild,
            );
            yield* finish();
            yield* Deferred.await(nativeEnded);
            if (settle) {
              yield* Deferred.await(finalized);
              yield* worker.drain(30);
              yield* Deferred.await(settled);
            }
            yield* Fiber.interrupt(nativeWatcher);
            yield* Fiber.interrupt(watcher);
            return run;
          });
        yield* completeLatest();
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("live-resume"),
          threadId: target,
        });
        yield* worker.drain(30);
        yield* Deferred.await(peerStarted);
        assert.equal(
          (yield* Ref.get(turns)).find(
            (input) => input.threadId === target && input.message.text.includes("/compact"),
          )?.message.text,
          `[Peer conversation content; swarm=${group.id}; sender-thread=${group.members[0]!.threadId}]\n/compact`,
        );
        const stopCommandId = CommandId.make("live-stop-group");
        yield* orchestrator.dispatch({
          type: "swarm.stop",
          commandId: stopCommandId,
          threadId: ownerId,
          swarmId: group.id,
          intentFingerprint: "live-stop",
        });
        const stopTargets = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox WHERE command_id = ${stopCommandId} AND effect_type = 'provider-turn.interrupt'`;
        assert.deepEqual(stopTargets, [{ count: 2 }]);
        yield* sql`UPDATE orchestration_v2_effect_outbox SET available_at = '2099-01-01T00:00:00.000Z' WHERE command_id = ${stopCommandId}`;
        yield* completeLatest(false);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("live-human"),
          threadId: target,
          messageId: MessageId.make("live-human"),
          text: "Human followup",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        const acceptedHuman = (yield* orchestrator.getThreadProjection(target)).runs.at(-1)!;
        assert.equal(acceptedHuman.swarmId, undefined);
        yield* sql`UPDATE orchestration_v2_effect_outbox SET available_at = '2000-01-01T00:00:00.000Z' WHERE command_id = ${stopCommandId}`;
        yield* worker.drain(30);
        const surviving = (yield* orchestrator.getThreadProjection(target)).runs.find(
          (run) => run.id === acceptedHuman.id,
        )!;
        assert.include(["queued", "starting", "running"], surviving.status);
        assert.notEqual(surviving.queueHeld, true);
        assert.equal(
          (yield* orchestrator.getThreadProjection(target)).messages.find(
            (message) => message.id === surviving.userMessageId,
          )?.text,
          "Human followup",
        );
        assert.equal((yield* orchestrator.getSwarm(group.id))?.lifecycle.state, "closed");
        yield* Fiber.interrupt(observer);
      }).pipe(Effect.provide(liveLayer));
    }),
);

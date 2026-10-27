import { vi } from "vite-plus/test";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  RunId,
  RunAttemptId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

it.effect.each(
  (
    [
      [false, "during delivery"],
      [false, "before dispatch"],
      [true, "after delivery"],
      [true, "without native steering"],
      [true, "with interrupting native steering"],
      [true, "settled only"],
      [false, "during continuation"],
      [false, "deferred-offered"],
      [false, "deferred-completed"],
      [true, "deferred-completed"],
      [false, "deferred-failed"],
      [true, "deferred-failed"],
      [true, "deferred-successor"],
      [true, "deferred-replay"],
      [true, "deferred-replay-stop"],
      [false, "deferred-stop"],
      [false, "deferred-disabled"],
      [true, "deferred-offered-disabled"],
      [false, "deferred-child"],
      [false, "deferred-parent-stop"],
      [false, "deferred-unregistered-stop"],
      [false, "deferred-stop-held"],
      [true, "deferred-known-offered"],
      [false, "deferred-rejected"],
      [true, "deferred-obsolete"],
      [false, "deferred-restart-cancelled"],
      [true, "deferred-restart-cancelled"],
      [false, "deferred-restart-offered"],
      [true, "deferred-restart-offered"],
      [false, "deferred-restart-failed"],
      [true, "deferred-restart-failed"],
      [false, "deferred-restart-completed"],
      [false, "deferred-restart-internal-cancelled"],
      [true, "deferred-restart-internal-offered"],
      [false, "deferred-restart-terminal"],
      [true, "deferred-restart-terminal"],
    ] as const
  ).map(([mailbox, timing]) => ({
    mailbox,
    timing,
    label: mailbox ? "mailbox notification" : "steering",
  })),
)("delivers $label when completion wins $timing", ({ mailbox, timing }) =>
  Effect.scoped(
    Effect.gen(function* () {
      let continuationRequests:
        | Context.Service.Shape<typeof ProviderContinuationRequests.ProviderContinuationRequests>
        | undefined;
      let settings: ServerSettings.ServerSettingsService["Service"] | undefined;
      if (timing.includes("disabled")) {
        const original = ServerSettings.layerTest();
        const shared = Layer.effect(
          ServerSettings.ServerSettingsService,
          Effect.gen(function* () {
            settings = yield* ServerSettings.ServerSettingsService;
            return settings;
          }),
        ).pipe(Layer.provide(original));
        const spy = vi.spyOn(ServerSettings, "layerTest").mockReturnValue(shared);
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      }
      const deferred = timing.startsWith("deferred-");
      const driver = ProviderDriverKind.make(deferred ? "claudeAgent" : "codex");
      const cwd = yield* checkpointWorkspace(`steering-completion-${timing.replaceAll(" ", "-")}`);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      const steerEntered = yield* Deferred.make<void>();
      const rejectSteer = yield* Deferred.make<void>();
      let steerCalls = 0;
      const capabilities = {
        ...CodexProviderCapabilitiesV2,
        turns: {
          ...CodexProviderCapabilitiesV2.turns,
          supportsActiveSteering: timing !== "without native steering",
          activeSteeringInterruptsTools: timing === "with interrupting native steering",
        },
      };
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(capabilities),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: (turn) =>
                Effect.gen(function* () {
                  steerCalls += 1;
                  if (timing === "deferred-rejected")
                    return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId: turn.providerTurnId,
                      cause: "Registration rejected",
                    });
                  if (deferred) return { deferred: true } as const;
                  if (timing === "after delivery" || timing === "during continuation") return;
                  yield* Deferred.succeed(steerEntered, undefined);
                  yield* Deferred.await(rejectSteer);
                  return yield* new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId: turn.providerTurnId,
                    cause: "turn already completed",
                  });
                }),
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.void,
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:steering-completion");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:steering-completion"),
          title: "Steering race",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("message:first"),
          text: "first",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;
        const messageId = MessageId.make("message:steering");
        const taskId = NodeId.make("task:mailbox");
        if (mailbox) {
          const sink = yield* EventSink.EventSinkV2;
          const current = yield* orchestrator.getThreadProjection(threadId);
          const parentRun = current.runs.find((run) => run.id === first.runId)!;
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make("mailbox:cohort"),
                type: "run.updated",
                threadId,
                runId: first.runId,
                occurredAt: now,
                payload: {
                  ...parentRun,
                  delegatedCompletion: {
                    disposition: "open",
                    nextGeneration: 2,
                    delivery: { generation: 1, messageId, taskIds: [taskId] },
                  },
                },
              },
              {
                id: EventId.make("mailbox:task"),
                type: "subagent.updated",
                threadId,
                runId: first.runId,
                nodeId: taskId,
                occurredAt: now,
                payload: {
                  id: taskId,
                  threadId,
                  runId: first.runId,
                  parentNodeId: first.rootNodeId,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver,
                  providerInstanceId: instanceId,
                  providerThreadId: null,
                  childThreadId: null,
                  nativeTaskRef: null,
                  prompt: "Do background work",
                  title: "Background test",
                  model: null,
                  completionWake: timing === "settled only" ? "settled_only" : "always",
                  completionDelivery: { state: "claimed", observedByRunId: null },
                  status: "completed",
                  result: "done",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        }
        const childFollowup = timing === "deferred-child" || timing === "deferred-parent-stop";
        const parentThreadId = ThreadId.make("parent:steering-completion");
        const parentRunId = RunId.make("parent:run");
        if (childFollowup) {
          const current = yield* orchestrator.getThreadProjection(threadId);
          const sink = yield* EventSink.EventSinkV2;
          const now = yield* DateTime.now;
          const parentNodeId = NodeId.make("parent:root");
          const parentProviderThreadId = ProviderThreadId.make("parent:provider-thread");
          const parentAttemptId = RunAttemptId.make("parent:attempt");
          const parentTurnId = ProviderTurnId.make("parent:turn");
          const originalTask = NodeId.make("parent:original-task");
          yield* sink.write({
            events: [
              {
                id: EventId.make("parent:created"),
                type: "thread.created",
                threadId: parentThreadId,
                occurredAt: now,
                payload: {
                  ...current.thread,
                  id: parentThreadId,
                  activeProviderThreadId: parentProviderThreadId,
                  lineage: {
                    parentThreadId: null,
                    rootThreadId: parentThreadId,
                    relationshipToParent: null,
                  },
                },
              },
              {
                id: EventId.make("child:lineage"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...current.thread,
                  lineage: {
                    parentThreadId,
                    rootThreadId: parentThreadId,
                    relationshipToParent: "subagent",
                  },
                  forkedFrom: { type: "node", nodeId: originalTask },
                },
              },
              {
                id: EventId.make("parent:provider"),
                type: "provider-thread.updated",
                threadId: parentThreadId,
                occurredAt: now,
                payload: {
                  ...current.providerThreads[0]!,
                  id: parentProviderThreadId,
                  appThreadId: parentThreadId,
                  providerSessionId: null,
                },
              },
              {
                id: EventId.make("parent:run"),
                type: "run.created",
                threadId: parentThreadId,
                runId: parentRunId,
                occurredAt: now,
                payload: {
                  ...current.runs[0]!,
                  id: parentRunId,
                  threadId: parentThreadId,
                  rootNodeId: parentNodeId,
                  activeAttemptId: parentAttemptId,
                  providerThreadId: parentProviderThreadId,
                },
              },
              {
                id: EventId.make("parent:attempt"),
                type: "run-attempt.created",
                threadId: parentThreadId,
                runId: parentRunId,
                occurredAt: now,
                payload: {
                  ...current.attempts[0]!,
                  id: parentAttemptId,
                  runId: parentRunId,
                  rootNodeId: parentNodeId,
                  providerThreadId: parentProviderThreadId,
                  providerTurnId: parentTurnId,
                },
              },
              {
                id: EventId.make("parent:turn"),
                type: "provider-turn.updated",
                threadId: parentThreadId,
                runId: parentRunId,
                occurredAt: now,
                payload: {
                  ...current.providerTurns[0]!,
                  id: parentTurnId,
                  nodeId: parentNodeId,
                  providerThreadId: parentProviderThreadId,
                  runAttemptId: parentAttemptId,
                },
              },
              {
                id: EventId.make("parent:task"),
                type: "subagent.updated",
                threadId: parentThreadId,
                runId: parentRunId,
                occurredAt: now,
                payload: {
                  id: originalTask,
                  threadId: parentThreadId,
                  runId: parentRunId,
                  parentNodeId,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver,
                  providerInstanceId: instanceId,
                  providerThreadId: first.providerThread.id,
                  childThreadId: threadId,
                  nativeTaskRef: null,
                  prompt: "Original task",
                  title: "Child",
                  model: null,
                  completionWake: "always",
                  completionDelivery: { state: "delivered", observedByRunId: null },
                  status: "completed",
                  result: "Done",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        }
        const dispatchSteer = orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId,
          text: "fix the popover",
          attachments: [
            {
              type: "image",
              id: "steering-screenshot",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ],
          dispatchMode: mailbox
            ? { type: "queue_after_active" }
            : { type: "steer_active", targetRunId: first.runId },
          createdBy: mailbox || childFollowup ? "agent" : "user",
          creationSource: mailbox ? "server" : childFollowup ? "mcp" : "web",
          ...(childFollowup ? { senderThreadId: parentThreadId } : {}),
          ...(mailbox
            ? {
                delegatedCompletion: {
                  parentRunId: first.runId,
                  generation: 1,
                  taskIds: [taskId],
                },
              }
            : {}),
        });
        if (timing !== "before dispatch") yield* dispatchSteer;
        if (timing === "during continuation") {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const turn = projection.providerTurns[0]!;
          const failed = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "failed",
          );
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "failed", completedAt: yield* DateTime.now },
          });
          yield* Fiber.join(failed);
          yield* worker.drain();
          assert.equal(steerCalls, 1);
          assert.lengthOf(started, 1);
          const continued = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(continued.runs[0]?.status, "running");
          assert.equal(
            continued.messages.find((message) => message.id === messageId)?.runId,
            first.runId,
          );
          return;
        }
        if (deferred) {
          const itemId = IdAllocator.derive.userTurnItem({ messageId });
          const before = yield* orchestrator.getThreadProjection(threadId);
          const turn = before.providerTurns[0]!;
          assert.equal(before.turnItems.find((row) => row.id === itemId)?.status, "pending");
          if (timing === "deferred-rejected" || timing === "deferred-obsolete") {
            if (timing === "deferred-obsolete") {
              const sink = yield* EventSink.EventSinkV2;
              const run = before.runs.find((row) => row.id === first.runId)!;
              yield* sink.write({
                events: [
                  {
                    id: EventId.make("obsolete-cohort"),
                    type: "run.updated",
                    threadId,
                    runId: run.id,
                    occurredAt: yield* DateTime.now,
                    payload: {
                      ...run,
                      delegatedCompletion: {
                        ...run.delegatedCompletion!,
                        disposition: "disposed",
                        delivery: null,
                      },
                    },
                  },
                ],
              });
            }
            yield* worker.drain();
            for (const delay of [100, 200, 400, 800]) {
              yield* TestClock.adjust(delay);
              yield* worker.drain();
            }
            const refused = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(refused.turnItems.find((row) => row.id === itemId)?.status, "failed");
            assert.equal(steerCalls, timing === "deferred-obsolete" ? 0 : 5);
            assert.equal(started.length, 1);
            assert.isTrue(
              refused.turnItems.some(
                (row) => row.type === "system_notice" && row.message.includes(messageId),
              ),
            );
            return;
          }
          if (timing !== "deferred-unregistered-stop") yield* worker.drain();
          assert.equal(steerCalls, timing === "deferred-unregistered-stop" ? 0 : 1);
          const held = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(held.turnItems.find((row) => row.id === itemId)?.status, "pending");
          if (mailbox) assert.equal(held.subagents[0]?.completionDelivery?.state, "claimed");
          if (timing.startsWith("deferred-restart-")) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("replace-attempt"),
              threadId,
              messageId: MessageId.make("replacement-input"),
              text: "Restart with B",
              attachments: [],
              dispatchMode: { type: "restart_active", targetRunId: first.runId },
              createdBy: "user",
              creationSource: "web",
            });
            const replacement = yield* orchestrator.getThreadProjection(threadId);
            assert.notEqual(replacement.runs[0]?.activeAttemptId, first.attemptId);
            const outcome = timing.endsWith("offered")
              ? "offered"
              : timing.endsWith("failed")
                ? "failed"
                : timing.endsWith("completed")
                  ? "completed"
                  : "cancelled";
            const settlement = {
              threadId,
              runId: first.runId,
              attemptId: first.attemptId,
              providerTurnId: turn.id,
              messageId,
              outcome,
            } as const;
            const terminalStatus = outcome === "completed" ? "completed" : "interrupted";
            const processed = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.id === turn.id &&
                event.payload.status === terminalStatus,
            );
            if (timing.includes("internal")) {
              yield* orchestrator.dispatch({
                ...settlement,
                type: "message.steer.settle",
                commandId: CommandId.make("old-attempt-direct"),
              });
            } else if (!timing.endsWith("terminal")) {
              yield* Queue.offer(events, { ...settlement, type: "steer.settled", driver });
            }
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...turn, status: terminalStatus, completedAt: yield* DateTime.now },
            });
            yield* Fiber.join(processed);
            if (timing.endsWith("terminal")) {
              const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
              yield* ingestor.ingestNormalized({
                threadId,
                runId: first.runId,
                nodeId: first.rootNodeId,
                providerSessionId: before.providerSessions[0]!.id,
                providerInstanceId: instanceId,
                event: {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThreadId,
                  providerTurnId: turn.id,
                  runOrdinal: first.runOrdinal,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              });
            }
            if ((mailbox && outcome === "offered") || outcome === "completed") {
              yield* orchestrator.dispatch({
                ...settlement,
                type: "message.steer.settle",
                commandId: CommandId.make("settle-old-outcome"),
              });
            }
            const after = yield* orchestrator.getThreadProjection(threadId);
            const marker = after.turnItems.find((row) => row.id === itemId);
            assert.equal(
              marker?.status,
              outcome === "offered"
                ? "completed"
                : outcome === "cancelled"
                  ? "cancelled"
                  : "failed",
            );
            assert.equal(marker?.providerTurnId, turn.id);
            assert.lengthOf(
              after.turnItems.filter(
                (row) => row.type === "system_notice" && row.message.includes(messageId),
              ),
              outcome === "offered" ? 0 : 1,
            );
            if (mailbox && outcome === "offered")
              assert.equal(after.subagents[0]?.completionDelivery?.state, "delivered");
            assert.equal(after.runs[0]?.activeAttemptId, replacement.runs[0]?.activeAttemptId);
            assert.lengthOf(after.runs, 1);
            assert.equal(started.length, 1);
            assert.equal(steerCalls, 1);
            return;
          }
          if (timing === "deferred-stop-held") {
            for (const index of [2, 3, 4])
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`held:${index}`),
                threadId,
                messageId: MessageId.make(`held:${index}`),
                text: `Held ${index}`,
                attachments: [],
                dispatchMode: { type: "steer_active", targetRunId: first.runId },
                createdBy: "agent",
                creationSource: "mcp",
              });
            yield* worker.drain();
            assert.equal(steerCalls, 4);
            yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId: CommandId.make("stop-held"),
              threadId,
            });
            yield* worker.drain();
            const cancelled = yield* watch(
              (event) =>
                event.type === "turn-item.updated" &&
                event.payload.id ===
                  IdAllocator.derive.userTurnItem({ messageId: MessageId.make("held:4") }) &&
                event.payload.status === "cancelled",
            );
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...turn, status: "cancelled", completedAt: yield* DateTime.now },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: first.runOrdinal,
              status: "cancelled",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(cancelled);
            const stopped = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(
              stopped.turnItems.filter(
                (row) => row.type === "user_message" && row.status === "cancelled",
              ).length,
              4,
            );
            assert.equal(started.length, 1);
            return;
          }
          if (timing === "deferred-unregistered-stop") {
            yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId: CommandId.make("stop-unregistered"),
              threadId,
            });
            const cancelled = yield* watch(
              (event) =>
                event.type === "turn-item.updated" &&
                event.payload.id === itemId &&
                event.payload.status === "cancelled",
            );
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: { ...turn, status: "cancelled", completedAt: yield* DateTime.now },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: first.runOrdinal,
              status: "cancelled",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(cancelled);
            yield* worker.drain();
            assert.equal(steerCalls, 0);
            assert.equal(started.length, 1);
            return;
          }

          const successor = timing === "deferred-successor" || timing.startsWith("deferred-replay");
          const sink = yield* EventSink.EventSinkV2;
          const taskB = NodeId.make("task:mailbox-B");
          if (successor)
            yield* sink.write({
              events: [
                {
                  id: EventId.make("task:B:completed"),
                  type: "subagent.updated",
                  threadId,
                  runId: first.runId,
                  occurredAt: yield* DateTime.now,
                  payload: {
                    ...held.subagents[0]!,
                    id: taskB,
                    completionDelivery: { state: "pending", observedByRunId: null },
                  },
                },
              ],
            });
          const outcome =
            timing === "deferred-completed" ||
            timing === "deferred-disabled" ||
            timing === "deferred-stop" ||
            childFollowup
              ? "completed"
              : timing === "deferred-failed"
                ? "failed"
                : "offered";
          if (timing.includes("disabled")) {
            if (settings === undefined) throw new Error("Missing shared test settings");
            const current = yield* settings.getSettings;
            yield* settings.updateSettings({
              providerInstances: {
                ...current.providerInstances,
                [instanceId]: { driver, ...current.providerInstances[instanceId], enabled: false },
              },
            });
          }
          if (outcome !== "offered" || timing === "deferred-known-offered") {
            const updated = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.id === turn.id &&
                event.payload.status !== "running",
            );
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                ...turn,
                status: outcome === "failed" ? "failed" : "completed",
                completedAt: yield* DateTime.now,
              },
            });
            yield* Fiber.join(updated);
          }
          const settled = yield* watch(
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.id === itemId &&
              event.payload.status !== "pending",
          );
          yield* Queue.offer(events, {
            type: "steer.settled",
            driver,
            threadId,
            runId: first.runId,
            attemptId: first.attemptId,
            providerTurnId: turn.id,
            messageId,
            outcome,
          });
          yield* Fiber.join(settled);
          const settlement = {
            type: "message.steer.settle" as const,
            commandId: CommandId.make(`command:effect:steer-settle:${turn.id}:${messageId}`),
            threadId,
            messageId,
            runId: first.runId,
            attemptId: first.attemptId,
            providerTurnId: turn.id,
            outcome,
          } as const;
          if (timing === "deferred-known-offered") {
            const requests = continuationRequests;
            if (requests === undefined) throw new Error("Missing shared continuation requests");
            const offered = vi.spyOn(requests, "offer");
            yield* Effect.addFinalizer(() => Effect.sync(() => offered.mockRestore()));
            yield* orchestrator.recoverDelegatedTasks;
            assert.equal(offered.mock.calls.length, 0);
            const rejected = yield* Deferred.make<void>();
            const commitRejected = sink.commitRejectedCommand;
            const rejection = vi
              .spyOn(sink, "commitRejectedCommand")
              .mockImplementation((input) =>
                commitRejected(input).pipe(
                  Effect.tap(() =>
                    input.commandType === "message.dispatch"
                      ? Deferred.succeed(rejected, undefined)
                      : Effect.void,
                  ),
                ),
              );
            yield* Effect.addFinalizer(() => Effect.sync(() => rejection.mockRestore()));
            yield* requests.offer({
              threadId,
              providerThreadId: turn.providerThreadId,
              driver,
              detail: null,
              delivery: "message_text",
              delegatedCompletion: { parentRunId: first.runId, generation: 1, messageId },
            });
            yield* Deferred.await(rejected);
            assert.equal(steerCalls, 1);
            assert.equal(started.length, 1);
            yield* worker.drain();
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).subagents[0]?.completionDelivery
                ?.state,
              "delivered",
            );
            return;
          }
          if (childFollowup) {
            const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
            const original = locks.withLock;
            const acquired: Array<ThreadId> = [];
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            let holdParent = timing === "deferred-parent-stop";
            const spy = vi
              .spyOn(locks, "withLock")
              .mockImplementation(<A, E, R>(key: ThreadId, effect: Effect.Effect<A, E, R>) => {
                const locked = original(
                  key,
                  Effect.sync(() => {
                    acquired.push(key);
                  }).pipe(Effect.andThen(effect)),
                );
                if (key !== parentThreadId || !holdParent) return locked;
                holdParent = false;
                return Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(locked),
                );
              });
            yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
            if (timing === "deferred-parent-stop") {
              const fallback = yield* orchestrator.dispatch(settlement).pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
              yield* orchestrator.dispatch({
                type: "thread.stop",
                commandId: CommandId.make("stop-parent"),
                threadId: parentThreadId,
              });
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(fallback);
              assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
              assert.lengthOf(
                (yield* orchestrator.getThreadProjection(parentThreadId)).subagents,
                1,
              );
            } else {
              yield* orchestrator.dispatch(settlement);
              assert.deepEqual(acquired.slice(0, 2), [parentThreadId, threadId]);
              const child = yield* orchestrator.getThreadProjection(threadId);
              const parent = yield* orchestrator.getThreadProjection(parentThreadId);
              const followup = child.runs.find((row) => row.id !== first.runId);
              assert.isDefined(followup?.delegatedTaskId);
              const task = parent.subagents.find((row) => row.id === followup?.delegatedTaskId);
              assert.equal(task?.childThreadId, threadId);
              assert.equal(task?.runId, parentRunId);
            }
            return;
          }
          if (timing === "deferred-stop") {
            const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
            const original = locks.withLock;
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const spy = vi
              .spyOn(locks, "withLock")
              .mockImplementationOnce(<A, E, R>(key: ThreadId, effect: Effect.Effect<A, E, R>) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(original(key, effect)),
                ),
              );
            yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
            const fallback = yield* orchestrator.dispatch(settlement).pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId: CommandId.make("stop-before-fallback"),
              threadId,
            });
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(fallback);
            assert.equal(started.length, 1);
            assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
            return;
          }
          if (successor) {
            const nextMessage = yield* watch(
              (event) =>
                event.type === "message.updated" &&
                event.payload.delegatedCompletion?.generation === 2,
            );
            if (timing.startsWith("deferred-replay")) {
              const requests = continuationRequests;
              if (requests === undefined) throw new Error("Missing shared continuation requests");
              const entered = yield* Deferred.make<void>();
              const spy = vi
                .spyOn(requests, "offer")
                .mockImplementationOnce(() =>
                  Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
                );
              yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
              const accepting = yield* orchestrator.dispatch(settlement).pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
              yield* Fiber.interrupt(accepting);
              spy.mockRestore();
              if (timing === "deferred-replay-stop") {
                yield* orchestrator.dispatch({
                  type: "thread.stop",
                  commandId: CommandId.make("stop-before-replay"),
                  threadId,
                });
                yield* orchestrator.dispatch(settlement);
                const stopped = yield* orchestrator.getThreadProjection(threadId);
                assert.equal(
                  stopped.subagents.find((row) => row.id === taskB)?.completionDelivery?.state,
                  "disposed",
                );
                assert.equal(steerCalls, 1);
                return;
              }
              yield* orchestrator.dispatch(settlement);
            } else yield* worker.drain();
            yield* Fiber.join(nextMessage);
            yield* worker.drain();
            const delivered = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(delivered.runs.find((row) => row.id === first.runId)?.status, "running");
            assert.equal(
              delivered.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
              "delivered",
            );
            assert.equal(
              delivered.subagents.find((row) => row.id === taskB)?.completionDelivery?.state,
              "claimed",
            );
            assert.equal(steerCalls, 2);
            yield* orchestrator.dispatch(settlement);
            yield* worker.drain();
            assert.equal(steerCalls, 2);
            assert.equal(started.length, 1);
            return;
          }
          yield* worker.drain();
          if (timing === "deferred-disabled") {
            const refused = yield* orchestrator.getThreadProjection(threadId);
            assert.lengthOf(refused.runs, 1);
            assert.equal(started.length, 1);
            assert.isTrue(
              refused.turnItems.some(
                (row) =>
                  row.type === "system_notice" && row.message.includes("provider is disabled"),
              ),
            );
            return;
          }
          if (outcome === "offered") {
            assert.equal(started.length, 1);
            const accepted = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(accepted.turnItems.find((row) => row.id === itemId)?.status, "completed");
            if (mailbox)
              assert.equal(accepted.subagents[0]?.completionDelivery?.state, "delivered");
            return;
          }
          if (outcome === "failed") {
            assert.equal(started.length, 1);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs.find(
                (row) => row.id === first.runId,
              )?.status,
              "running",
            );
          }
          const terminal = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              (event.payload.status === "waiting" || event.payload.status === "failed"),
          );
          const redelivered =
            mailbox && outcome === "failed"
              ? yield* watch(
                  (event) =>
                    event.type === "message.updated" &&
                    event.payload.id === messageId &&
                    event.payload.runId !== first.runId,
                )
              : null;
          yield* Queue.offer(
            events,
            outcome === "failed"
              ? {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThreadId,
                  providerTurnId: turn.id,
                  runOrdinal: first.runOrdinal,
                  failureItemOrdinal: 99,
                  status: "failed",
                  failure: makeProviderFailure({ class: "provider_error" }),
                  threadDisposition: "reusable",
                }
              : {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThreadId,
                  providerTurnId: turn.id,
                  runOrdinal: first.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
          );
          yield* Fiber.join(terminal);
          if (redelivered !== null) yield* Fiber.join(redelivered);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          const final = yield* orchestrator.getThreadProjection(threadId);
          if (outcome === "failed" && !mailbox) {
            assert.equal(started.length, 1);
            assert.equal(final.messages.find((row) => row.id === messageId)?.runId, first.runId);
            assert.isTrue(
              final.turnItems.some(
                (row) => row.type === "system_notice" && row.message.includes(messageId),
              ),
            );
          } else {
            assert.equal(started.length, 2);
            assert.equal(started[1]?.message.messageId, messageId);
            const stale = { ...settlement, commandId: CommandId.make("stale-settlement") };
            yield* orchestrator.dispatch(stale);
            yield* orchestrator.dispatch(stale);
            yield* worker.drain();
            assert.equal(started.length, 2);
          }
          return;
        }

        if (timing === "after delivery") yield* worker.drain();
        const delivery =
          timing === "during delivery" ? yield* worker.runOnce.pipe(Effect.forkScoped) : null;
        if (delivery !== null) yield* Deferred.await(steerEntered);
        const completed = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const turn = projection.providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(completed);
        if (delivery !== null) {
          yield* Deferred.succeed(rejectSteer, undefined);
          yield* Fiber.join(delivery);
        }
        if (timing === "before dispatch") yield* dispatchSteer;
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        if (timing === "after delivery") {
          assert.equal(steerCalls, 1);
          assert.equal(started.length, 1);
          if (mailbox) {
            const delivered = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(delivered.subagents[0]?.completionDelivery?.state, "delivered");
            assert.equal(delivered.subagents[0]?.completionDelivery?.observedByRunId, null);
            assert.equal(delivered.runs[0]?.delegatedCompletion?.delivery, null);
            assert.equal(
              delivered.turnItems.filter((item) => item.type === "notification").length,
              1,
            );
            yield* orchestrator.dispatch({
              type: "notification.delivery.accept",
              commandId: CommandId.make("duplicate-acceptance"),
              threadId,
              messageId,
            });
            yield* worker.drain();
            assert.equal(steerCalls, 1);
            yield* orchestrator.dispatch({
              type: "delegated_task.completion-delivery.acknowledge",
              commandId: CommandId.make("read-result"),
              parentThreadId: threadId,
              taskId,
              observedByRunId: first.runId,
            });
            const acknowledged = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(acknowledged.subagents[0]?.completionDelivery?.state, "acknowledged");
          }
          return;
        }
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, messageId);
        if (mailbox) assert.include(started[1]?.message.text ?? "", String(taskId));
        else assert.equal(started[1]?.message.text, "fix the popover");
        assert.deepEqual(started[1]?.message.attachments, [
          {
            type: "image",
            id: "steering-screenshot",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ]);
        assert.equal(steerCalls, timing === "during delivery" ? 1 : 0);
        const final = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(final.messages.filter((message) => message.id === messageId).length, 1);
        assert.equal(
          final.messages.find((message) => message.id === messageId)?.runId,
          started[1]?.runId,
        );
        assert.equal(
          final.turnItems.filter((item) =>
            mailbox
              ? item.type === "notification"
              : item.type === "user_message" && item.messageId === messageId,
          ).length,
          1,
        );
        yield* worker.drain();
        assert.equal(started.length, 2);
      }).pipe(
        Effect.provide(
          Layer.merge(
            ThreadCommandExecutor.layer,
            ProviderReplayHarness.layerWithRegistry(
              { name: `steering-completion-${timing}` },
              Layer.effect(
                ProviderAdapterRegistry.ProviderAdapterRegistryV2,
                Effect.gen(function* () {
                  continuationRequests =
                    yield* ProviderContinuationRequests.ProviderContinuationRequests;
                  return yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
                }),
              ).pipe(Layer.provide(ProviderAdapterRegistry.layerSingle(adapter))),
              { runEffectWorker: false, runContinuationWorker: deferred },
            ),
          ),
        ),
      );
    }),
  ),
);

const runSelection = {
  instanceId,
  model: "test-model",
  options: [{ id: "effort", value: "xhigh" }],
};
const composerSelection = {
  ...runSelection,
  options: [...runSelection.options, { id: "fastMode", value: false }],
};

const nextTurnSelectionHarness = Effect.fn("nextTurnSelectionHarness")(function* (
  name: string,
  canRestart = false,
) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: true,
      supportsSteeringByInterruptRestart: canRestart,
    },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            started.push(turn);
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native:${turn.attemptId}`,
                  strength: "strong",
                },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: now,
                completedAt: null,
              },
            });
          });
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: runSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn,
          compactThread: startTurn,
          steerTurn: (turn) =>
            Effect.sync(() => {
              steered.push(turn.message.text);
            }),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    { runEffectWorker: false },
  );
  const startFirstTurn = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Steer with changed options",
      modelSelection: runSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    return threadId;
  });
  return { cwd, events, started, steered, layer, startFirstTurn };
});

it.effect("sends a selected held message once and preserves the remaining queue order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("send-held-message");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* Effect.forEach(["queued-first", "selected", "queued-last"], (text) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(text),
            threadId,
            messageId: MessageId.make(`message:${text}`),
            text,
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          }),
        );
        const before = yield* orchestrator.getThreadProjection(threadId);
        const selected = before.runs.find(
          (run) => run.userMessageId === MessageId.make("message:selected"),
        )!;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        // Restart recovery cancels the active run and holds every queued message.
        yield* sink.write({
          events: [
            ...before.runs.map((run) => ({
              id: EventId.make(`restart:${run.id}`),
              type: "run.updated" as const,
              threadId,
              runId: run.id,
              occurredAt: now,
              payload:
                run.status === "queued"
                  ? { ...run, queueHeld: true }
                  : { ...run, status: "cancelled" as const, completedAt: now },
            })),
            ...before.providerTurns.map((turn) => ({
              id: EventId.make(`restart:${turn.id}`),
              type: "provider-turn.updated" as const,
              threadId,
              occurredAt: now,
              payload: { ...turn, status: "cancelled" as const, completedAt: now },
            })),
          ],
        });
        const command = {
          type: "queued-run.start" as const,
          commandId: CommandId.make("send-selected"),
          threadId,
          runId: selected.id,
        };
        yield* orchestrator.dispatch(command);
        yield* worker.drain();
        yield* orchestrator.dispatch(command);
        yield* worker.drain();
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.find((run) => run.id === selected.id)?.status, "running");
        assert.deepEqual(
          started.map((input) => input.message.text),
          ["first", "selected"],
        );
        assert.equal(started[1]?.runId, selected.id);
        assert.equal(started[1]?.message.messageId, selected.userMessageId);
        assert.deepEqual(started[1]?.modelSelection, runSelection);
        assert.deepEqual(steered, []);
        assert.lengthOf(
          after.messages.filter((message) => message.id === selected.userMessageId),
          1,
        );
        assert.deepEqual(
          after.runs.filter((run) => run.status === "queued").map((run) => run.userMessageId),
          [MessageId.make("message:queued-first"), MessageId.make("message:queued-last")],
        );
        assert.isFalse(after.runs.some((run) => run.status === "queued" && run.queueHeld));
        const duplicate = yield* orchestrator
          .dispatch({
            ...command,
            commandId: CommandId.make("send-selected-again"),
          })
          .pipe(Effect.flip);
        assert.equal(duplicate._tag, "OrchestratorDispatchError");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps a message queued when send now races with a running turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("send-queued-race");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queue"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        const queued = before.runs.find((run) => run.status === "queued")!;
        const error = yield* orchestrator
          .dispatch({
            type: "queued-run.start",
            commandId: CommandId.make("send-now"),
            threadId,
            runId: queued.id,
          })
          .pipe(Effect.flip);
        yield* worker.drain();
        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.equal(started.length, 1);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(after.runs, before.runs);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// regression: #19210 a provider that can restart the turn must still steer, since restarting ends its native subagents
it.effect(
  "steers a changed turn-scoped selection into a running turn the provider could restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          "steering-selection-change",
          true,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const steer = (id: string, selection: ModelSelection) =>
            orchestrator
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(id),
                threadId,
                messageId: MessageId.make(`message:${id}`),
                text: id,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(Effect.andThen(worker.drain()));

          yield* steer("steer-changed", composerSelection);
          const changed = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed"]);
          assert.equal(started.length, 1);
          assert.lengthOf(changed.attempts, 1);
          assert.equal(changed.runs[0]?.status, "running");
          assert.deepEqual(changed.runs[0]?.modelSelection, runSelection);
          assert.deepEqual(changed.thread.modelSelection, composerSelection);

          yield* steer("steer-reverted", runSelection);
          const reverted = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted"]);
          assert.lengthOf(reverted.attempts, 1);
          assert.deepEqual(reverted.thread.modelSelection, runSelection);

          const otherSelection = {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "other",
          };
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.write({
            events: [
              {
                id: EventId.make("switched-away"),
                type: "thread.provider-switched",
                threadId,
                providerInstanceId: otherSelection.instanceId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...reverted.thread,
                  providerInstanceId: otherSelection.instanceId,
                  modelSelection: otherSelection,
                },
              },
            ],
          });
          yield* steer("steer-back", runSelection);
          const back = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, ["steer-changed", "steer-reverted", "steer-back"]);
          assert.equal(back.thread.providerInstanceId, instanceId);
          assert.deepEqual(back.thread.modelSelection, runSelection);
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("starts a steer that missed the turn on the saved next-turn selection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-selection-follow-up",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "late steer",
          attachments: [],
          modelSelection: composerSelection,
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === first.runId &&
              event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, MessageId.make("message:steer"));
        assert.deepEqual(started[1]?.modelSelection, composerSelection);
        assert.deepEqual(projection.thread.modelSelection, composerSelection);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// Codex flushes held drafts after the final answer; reserve their pre-steer position before turn end.
it.effect("keeps a held commentary draft before the steer when turn end flushes it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-held-draft");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const now = yield* DateTime.now;
        const assistantItem = (id: string, text: string, streaming: boolean) =>
          ({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: TurnItemId.make(id),
              threadId,
              runId: first.runId,
              nodeId: first.rootNodeId,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: streaming ? "running" : "completed",
              title: null,
              startedAt: now,
              completedAt: streaming ? null : now,
              updatedAt: now,
              type: "assistant_message",
              messageId: MessageId.make(`message:${id}`),
              text,
              streaming,
            },
          }) satisfies ProviderAdapter.ProviderAdapterV2Event;
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );

        yield* Queue.offer(events, assistantItem("draft", "Let me look at the", true));
        const commentaryWritten = yield* watch(
          (event) => event.type === "turn-item.updated" && event.payload.id === "commentary",
        );
        yield* Queue.offer(events, assistantItem("commentary", "Checking the popover.", false));
        yield* Fiber.join(commentaryWritten);

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:steer"),
          text: "fix the popover",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(events, assistantItem("answer", "All fixed.", false));
        yield* Queue.offer(events, assistantItem("draft", "Let me look at the", false));
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: turn.providerThreadId,
          providerTurnId: turn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();

        const items = (yield* orchestrator.getThreadProjection(threadId)).turnItems
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .flatMap((item) =>
            item.type === "user_message"
              ? [String(item.messageId)]
              : item.type === "assistant_message"
                ? [String(item.id)]
                : [],
          );
        assert.deepEqual(items, [
          "message:first",
          "draft",
          "commentary",
          "message:steer",
          "answer",
        ]);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps a queued message queued when promoted into a run that Stop reached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("steering-after-stop");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.status === "queued",
        )!;
        // The worker has not delivered the interrupt yet, so the run still reads as running.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: first.runId,
          holdQueue: true,
        });

        const promoteError = yield* orchestrator
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote"),
            threadId,
            queuedRunId: queuedRun.id,
            targetRunId: first.runId,
          })
          .pipe(Effect.flip);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(promoteError._tag, "OrchestratorDispatchError");
        assert.deepEqual(steered, []);
        const queued = projection.runs.find((run) => run.id === queuedRun.id);
        assert.equal(queued?.status, "queued");
        assert.isTrue(queued?.queueHeld);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("queues a plain send behind the stopped queue and releases its hold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("plain-send-after-stop");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const send = (id: string, delivery: "queue" | "auto") =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            modelSelection: runSelection,
            ...(delivery === "queue"
              ? { dispatchMode: { type: "queue_after_active" } }
              : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
            createdBy: "user",
            creationSource: "web",
          });
        yield* send("queued", "queue");
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: started[0]!.runId,
          holdQueue: true,
        });
        // The provider has not stopped yet, so a plain send still resolves to a steer.
        yield* send("sent", "auto");
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.equal(started.length, 1);
        const queued = projection.runs
          .filter((run) => run.status === "queued")
          .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
        assert.deepEqual(
          queued.map(
            (run) => projection.messages.find((message) => message.id === run.userMessageId)?.text,
          ),
          ["queued", "sent"],
        );
        // The user sent it, so the queue they stopped runs again once the provider stops.
        assert.isFalse(queued.some((run) => run.queueHeld === true));
      }).pipe(Effect.provide(layer));
    }),
  ),
);

const goalHarness = Effect.fn("goalHarness")(function* (name: string) {
  const harness = yield* nextTurnSelectionHarness(name);
  const send = (id: string, text: string, delivery: "queue" | "auto") =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId: ThreadId.make(`thread:${name}`),
        messageId: MessageId.make(`message:${id}`),
        text,
        attachments: [],
        modelSelection: runSelection,
        ...(delivery === "queue"
          ? { dispatchMode: { type: "queue_after_active" } }
          : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
        createdBy: "user",
        creationSource: "web",
      });
    });
  const read = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
      const textOf = (run: (typeof projection.runs)[number]) =>
        projection.messages.find((message) => message.id === run.userMessageId)?.text;
      return {
        queue: projection.runs
          .filter((run) => run.status === "queued")
          .toSorted((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))
          .map(textOf),
        started: harness.started.map((turn) => turn.message.text),
        stopRequested: projection.turnItems.some(
          (item) =>
            item.type === "run_interrupt_request" && item.runId === harness.started[0]?.runId,
        ),
      };
    });
  return { ...harness, send, read };
});

it.effect("stops the running turn and starts a goal sent into it next", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steered, layer, startFirstTurn, send, read } = yield* goalHarness("goal-steer");
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* send("goal", "/goal all tests pass", "auto");
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued"],
          started: ["first", "/goal all tests pass"],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("queues a goal clear without stopping work when no goal drives it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steered, layer, startFirstTurn, send, read } = yield* goalHarness("goal-clear");
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* send("clear", "/goal clear", "auto");
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued", "/goal clear"],
          started: ["first"],
          stopRequested: false,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("promotes a queued goal by stopping the running turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn, send, read } =
        yield* goalHarness("goal-promote");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        yield* send("queued", "queued", "queue");
        yield* send("goal", "/goal ship it", "queue");
        const goalRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === MessageId.make("message:goal"),
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: goalRun.id,
          targetRunId: started[0]!.runId,
        });
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: ["queued"],
          started: ["first", "/goal ship it"],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(["next", "/goal ship it"])(
  "promoting %s into a compaction stops it and sends it next",
  (promoted) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, layer, send, read, started, steered, startFirstTurn } = yield* goalHarness(
          `compaction-promote-${promoted.length}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          yield* send("compact", "/compact", "queue");
          yield* send("queued", "queued", "queue");
          yield* send("next", promoted, "queue");
          const settled = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === started[0]!.runId &&
                event.payload.status === "waiting",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const compacting = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.status === "running" &&
                event.payload.runAttemptId !== started[0]!.attemptId,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
          });
          yield* Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThreadId,
            providerTurnId: turn.id,
            runOrdinal: started[0]!.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          yield* Fiber.join(settled);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          yield* Fiber.join(compacting);
          const compactRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === MessageId.make("message:compact"),
          )!;
          const nextRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.userMessageId === MessageId.make("message:next"),
          )!;
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote"),
            threadId,
            queuedRunId: nextRun.id,
            targetRunId: compactRun.id,
          });
          yield* worker.drain();

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, []);
          assert.isTrue(
            projection.turnItems.some(
              (item) => item.type === "run_interrupt_request" && item.runId === compactRun.id,
            ),
          );
          assert.deepEqual((yield* read(threadId)).queue, ["queued"]);
          assert.deepEqual(
            started.map((turn) => turn.message.text),
            ["first", "/compact", promoted],
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("stops a turn that is still starting when a goal is sent into it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer, send, started } = yield* goalHarness("goal-during-start");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:goal-during-start");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:goal-during-start"),
          title: "Goal during start",
          modelSelection: runSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        // The stopped run's end starts the queue, which then needs one more drain.
        const goalStarting = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "starting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* send("first", "first", "auto");
        yield* send("goal", "/goal all tests pass", "auto");
        yield* worker.drain();
        yield* Fiber.join(goalStarting);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        const statusOf = (text: string) =>
          projection.runs.find(
            (run) =>
              projection.messages.find((message) => message.id === run.userMessageId)?.text ===
              text,
          )?.status;
        assert.equal(statusOf("first"), "interrupted");
        assert.deepEqual(
          started.map((turn) => turn.message.text),
          ["/goal all tests pass"],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("stops the running turn when a goal clear ends the goal driving it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, layer, startFirstTurn, send, read, steered } =
        yield* goalHarness("goal-clear-active");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const providerThread = (yield* orchestrator.getThreadProjection(threadId))
          .providerThreads[0]!;
        const goalSeen = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-thread.updated" && event.payload.goal?.status === "active",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Queue.offer(events, {
          type: "provider_thread.updated",
          driver,
          providerThread: {
            ...providerThread,
            goal: { objective: "all tests pass", status: "active" },
          },
        });
        yield* Fiber.join(goalSeen);
        yield* send("clear", "/goal clear", "auto");
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(yield* read(threadId), {
          queue: [],
          started: ["first", "/goal clear"],
          stopRequested: true,
        });
      }).pipe(Effect.provide(layer));
    }),
  ),
);

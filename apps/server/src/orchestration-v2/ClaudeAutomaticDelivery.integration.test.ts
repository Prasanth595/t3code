import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskUpsertInput,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const sessionId = "automatic-delivery-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const decodeScheduledTask = Schema.decodeEffect(ScheduledTaskUpsertInput);
const refusal =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";
const statusIds = ["status-1", "status-2", "status-3", "status-4"];
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};

function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}

const batch = frame({
  type: "assistant",
  uuid: "batch",
  session_id: sessionId,
  parent_tool_use_id: null,
  message: {
    id: "tool-batch",
    role: "assistant",
    type: "message",
    model: modelSelection.model,
    content: [
      { type: "tool_use", id: "build", name: "Bash", input: { command: "make" } },
      ...statusIds.map((id) => ({
        type: "tool_use",
        id,
        name: "mcp__t3-code__task_status",
        input: { taskId: id },
      })),
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});

const toolResult = (id: string, cancelled: boolean) =>
  frame({
    type: "user",
    uuid: `result-${id}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: cancelled,
          content: cancelled ? refusal : id === "build" ? "build OK" : "Task completed normally",
        },
      ],
    },
    ...(cancelled ? { tool_result_meta: [{ id, non_execution_kind: "cancelled" }] } : {}),
  });

const result = (uuid: string, aborted: boolean) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    terminal_reason: aborted ? "aborted_tools" : "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });

const deliveries = [
  "child completion",
  "scheduled message",
  "user steering",
  "promoted queued message",
] as const;

it.effect.each(deliveries)(
  "delivers %s with Claude's native pending-tool cancellation behavior",
  (delivery) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("claude-automatic-delivery");
        const sdkMessages = yield* Queue.unbounded<SDKMessage>();
        const offers: SDKUserMessage[] = [];
        const nativeQueue: SDKUserMessage[] = [];
        const batchAbort = new AbortController();
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: modelSelection.instanceId,
          settings,
          environment: {},
          attachmentsDir: cwd,
          fileSystem: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.succeed(sessionId),
            open: () =>
              Effect.succeed({
                messages: Stream.fromQueue(sdkMessages),
                offer: (message) =>
                  Effect.sync(() => {
                    offers.push(message);
                    nativeQueue.push(message);
                    // Claude Code 2.1.289's queue watcher aborts when a now-priority
                    // command arrives, including while Bash blocks pending reads.
                    if (nativeQueue.some((command) => command.priority === "now")) {
                      batchAbort.abort({ kind: "interrupt" });
                    }
                  }),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                stopTask: () => Effect.void,
                interrupt: Effect.die("automatic delivery must never interrupt"),
                close: Effect.void,
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:automatic-delivery");
          const projectId = ProjectId.make("project:automatic-delivery");
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
            projectId,
            title: "Automatic delivery",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("first"),
            threadId,
            messageId: MessageId.make("first"),
            text: "Build and check all four tasks.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(running);
          const pending = yield* watch(
            (event) =>
              event.type === "turn-item.updated" &&
              event.payload.nativeItemRef?.nativeId === "status-4",
          );
          yield* Queue.offer(sdkMessages, batch);
          yield* Fiber.join(pending);
          const before = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(before.turnItems.filter((item) => item.status === "running").length, 5);
          const parent = before.runs[0]!;
          if (parent.rootNodeId === null) return yield* Effect.die("parent has no root node");
          const messageId = MessageId.make("automatic-notice");
          if (delivery === "child completion") {
            const taskId = NodeId.make("completed-child");
            const now = yield* DateTime.now;
            const sink = yield* EventSink.EventSinkV2;
            yield* sink.write({
              events: [
                {
                  id: EventId.make("cohort"),
                  type: "run.updated",
                  threadId,
                  runId: parent.id,
                  occurredAt: now,
                  payload: {
                    ...parent,
                    delegatedCompletion: {
                      disposition: "open",
                      nextGeneration: 2,
                      delivery: { generation: 1, messageId, taskIds: [taskId] },
                    },
                  },
                },
                {
                  id: EventId.make("child"),
                  type: "subagent.updated",
                  threadId,
                  runId: parent.id,
                  nodeId: taskId,
                  occurredAt: now,
                  payload: {
                    id: taskId,
                    threadId,
                    runId: parent.id,
                    parentNodeId: parent.rootNodeId,
                    origin: "app_owned",
                    createdBy: "agent",
                    driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                    providerInstanceId: modelSelection.instanceId,
                    providerThreadId: null,
                    childThreadId: null,
                    nativeTaskRef: null,
                    prompt: "Background work",
                    title: "Child",
                    model: null,
                    completionWake: "always",
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
            const command = {
              type: "message.dispatch" as const,
              commandId: CommandId.make("completion"),
              threadId,
              messageId,
              text: "Child completed",
              attachments: [],
              dispatchMode: { type: "queue_after_active" as const },
              createdBy: "agent" as const,
              creationSource: "server" as const,
              delegatedCompletion: { parentRunId: parent.id, generation: 1, taskIds: [taskId] },
            };
            yield* orchestrator.dispatch(command);
            yield* orchestrator.dispatch(command);
            yield* orchestrator.recoverDelegatedTasks;
          } else if (delivery === "scheduled message") {
            yield* Effect.gen(function* () {
              const service = yield* ScheduledTaskService.ScheduledTaskService;
              const { task } = yield* service.upsert(
                yield* decodeScheduledTask({
                  title: "Status check",
                  prompt: "Check the four tasks.",
                  enabled: true,
                  schedule: { type: "interval", everyMs: 60_000 },
                  projectId,
                  threadId,
                  workspaceStrategy: { type: "root" },
                  modelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                }),
              );
              const ran = yield* service.runNow({ id: task.id });
              assert.equal(ran.task.lastRunStatus, "succeeded");
            }).pipe(
              Effect.provide(
                ScheduledTaskService.layer.pipe(
                  Layer.provide(ThreadManagementService.layer),
                  Layer.provide(ServerSettings.layerTest()),
                  Layer.provide(
                    Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
                      ensureTranscript: () =>
                        Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
                    }),
                  ),
                  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
                  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
                  Layer.provide(
                    CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
                  ),
                  Layer.provide(
                    Layer.mergeAll(
                      NodeCrypto.layer,
                      Scheduler.layer,
                      SqlitePersistence.layerMemory,
                    ),
                  ),
                ),
              ),
            );
          } else if (delivery === "user steering") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("steer"),
              threadId,
              messageId,
              text: "Change direction now.",
              attachments: [],
              dispatchMode: { type: "steer_active", targetRunId: parent.id },
              createdBy: "user",
              creationSource: "web",
            });
          } else {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("queue"),
              threadId,
              messageId,
              text: "Change direction now.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            const queuedRun = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
            yield* orchestrator.dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("promote"),
              threadId,
              queuedRunId: queuedRun.id,
              targetRunId: parent.id,
            });
            // Promotion cancels the queued run and moves its message into the
            // running run as a steer that remembers where it came from.
            const promoted = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(promoted.runs.find((run) => run.id === queuedRun.id)?.status, "cancelled");
            assert.equal(
              promoted.messages.find((message) => message.id === messageId)?.runId,
              parent.id,
            );
            const steer = promoted.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === messageId,
            );
            assert.ok(steer?.type === "user_message");
            assert.equal(steer.inputIntent, "promoted_queued_to_steer");
          }
          yield* worker.drain();
          const explicitSteer =
            delivery === "user steering" || delivery === "promoted queued message";
          assert.equal(batchAbort.signal.aborted, explicitSteer);
          assert.equal(offers.length, explicitSteer ? 2 : 1);
          const finished = yield* watch(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === parent.id &&
              event.payload.status === "waiting",
          );
          yield* Queue.offer(sdkMessages, toolResult("build", false));
          for (const id of statusIds)
            yield* Queue.offer(sdkMessages, toolResult(id, batchAbort.signal.aborted));
          if (explicitSteer) yield* Queue.offer(sdkMessages, result("aborted", true));
          yield* Queue.offer(sdkMessages, result("completed", false));
          yield* Fiber.join(finished);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          if (!explicitSteer) {
            const queued = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
            const noticeFinished = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === queued.id &&
                event.payload.status === "waiting",
            );
            const delivered =
              delivery === "child completion"
                ? yield* watch(
                    (event) =>
                      event.type === "subagent.updated" &&
                      event.payload.completionDelivery?.state === "delivered",
                  )
                : null;
            yield* Queue.offer(sdkMessages, result("notice-completed", false));
            yield* Fiber.join(noticeFinished);
            yield* worker.drain();
            if (delivered !== null) yield* Fiber.join(delivered);
          }
          const after = yield* orchestrator.getThreadProjection(threadId);
          const reads = after.turnItems.filter((item) =>
            statusIds.includes(item.nativeItemRef?.nativeId ?? ""),
          );
          assert.equal(reads.length, 4);
          for (const read of reads) {
            assert.equal(read.status, explicitSteer ? "cancelled" : "completed");
            assert.equal(read.toolNonExecutionKind, explicitSteer ? "cancelled" : undefined);
            assert.equal(read.type === "dynamic_tool" && read.output === refusal, explicitSteer);
          }
          assert.equal(offers.length, 2);
          assert.equal(
            offers.filter((offer) => offer.priority === "now").length,
            explicitSteer ? 1 : 0,
          );
          if (!explicitSteer) {
            assert.equal(after.runs.length, 2);
            if (delivery === "child completion") {
              assert.equal(after.messages.filter((message) => message.id === messageId).length, 1);
              assert.equal(after.subagents[0]?.completionDelivery?.state, "delivered");
            } else {
              assert.equal(
                after.messages.filter((message) => message.scheduledTaskId !== undefined).length,
                1,
              );
            }
          }
          yield* orchestrator.recoverDelegatedTasks;
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          assert.equal(offers.length, 2);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "claude-automatic-delivery" },
              ProviderAdapterRegistry.layerSingle(adapter),
              { runEffectWorker: false },
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
);

it.effect("persists a resumed subagent outcome when its buffered wake is dropped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("claude-dropped-wake");
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const wakes =
        yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
      const processed = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
      const lastOutcomeConsumed = yield* Deferred.make<void>();
      const offer = Effect.fnUntraced(function* (message: SDKMessage) {
        const done = yield* Deferred.make<void>();
        processed.set(message, done);
        yield* Queue.offer(sdkMessages, message);
        yield* Deferred.await(done);
      });
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: modelSelection.instanceId,
        settings,
        environment: {},
        attachmentsDir: cwd,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        continuationRequests: {
          offer: (request) => Queue.offer(wakes, request).pipe(Effect.asVoid),
        },
        queryRunner: {
          allocateSessionId: Effect.succeed(sessionId),
          open: () =>
            Effect.succeed({
              messages: Stream.fromQueue(sdkMessages).pipe(
                Stream.flatMap((message) =>
                  Stream.make(message).pipe(
                    Stream.concat(
                      Stream.fromEffect(
                        Effect.suspend(() => {
                          const done = processed.get(message);
                          return done === undefined
                            ? Effect.void
                            : Deferred.succeed(done, undefined);
                        }),
                      ).pipe(Stream.drain),
                    ),
                  ),
                ),
              ),
              offer: () => Effect.void,
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              stopTask: () => Effect.void,
              interrupt: Effect.void,
              close: Effect.void,
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      // Acknowledge after the session manager consumes the actual adapter event,
      // so a missing projection fails an assertion rather than a timeout.
      let pendingWork = Effect.succeed(false);
      const observedAdapter = {
        ...adapter,
        openSession: (input: Parameters<typeof adapter.openSession>[0]) =>
          adapter.openSession(input).pipe(
            Effect.map((runtime) => {
              pendingWork = runtime.hasPendingBackgroundWork ?? Effect.succeed(false);
              return {
                ...runtime,
                events: runtime.events.pipe(
                  Stream.flatMap((event) =>
                    Stream.make(event).pipe(
                      Stream.concat(
                        Stream.fromEffect(
                          event.type === "subagent.updated" &&
                            event.subagent.result === "Resumed work finished."
                            ? Deferred.succeed(lastOutcomeConsumed, undefined)
                            : Effect.void,
                        ).pipe(Stream.drain),
                      ),
                    ),
                  ),
                ),
              };
            }),
          ),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:dropped-wake");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-dropped-wake"),
          threadId,
          projectId: ProjectId.make("project:dropped-wake"),
          title: "Dropped wake",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-dropped-wake"),
          threadId,
          messageId: MessageId.make("start-dropped-wake"),
          text: "Start background research.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const start = (toolUseId: string) =>
          frame({
            type: "system",
            subtype: "task_started",
            task_id: "research",
            tool_use_id: toolUseId,
            description: "Research",
            task_type: "local_agent",
            subagent_type: "general-purpose",
            is_backgrounded: true,
            uuid: toolUseId,
            session_id: sessionId,
          });
        const complete = (toolUseId: string, summary: string) =>
          frame({
            type: "system",
            subtype: "task_notification",
            task_id: "research",
            tool_use_id: toolUseId,
            status: "completed",
            summary,
            output_file: "/tmp/research.output",
            uuid: `end-${toolUseId}`,
            session_id: sessionId,
          });
        const started = yield* watch(
          (event) => event.type === "subagent.updated" && event.payload.status === "running",
        );
        yield* offer(start("original"));
        yield* Fiber.join(started);
        const settled = yield* watch(
          (event) => event.type === "run.updated" && event.payload.status === "waiting",
        );
        yield* offer(result("root-finished", false));
        yield* Fiber.join(settled);
        yield* worker.drain();
        const completed = yield* watch(
          (event) =>
            event.type === "subagent.updated" && event.payload.result === "Original work finished.",
        );
        yield* offer(complete("original", "Original work finished."));
        yield* Fiber.join(completed);
        yield* worker.drain();
        const oldWake = yield* Queue.take(wakes);
        assert.isDefined(oldWake.clearIfCurrent);

        // The first subagent completion lets the old run stop ingesting.
        // Its next native generation must survive cleanup of the earlier wake.
        yield* offer(start("resumed"));
        yield* oldWake.clearIfCurrent!();
        assert.isTrue(yield* pendingWork, "dropping the old wake preserves the resumed generation");
        yield* offer(complete("resumed", "Resumed work finished."));
        const newWake = yield* Queue.take(wakes);
        assert.isDefined(newWake.clearIfCurrent);
        yield* newWake.clearIfCurrent!();
        yield* Deferred.await(lastOutcomeConsumed);
        yield* worker.drain();
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const subagent = projection.subagents.find(
          (task) => task.nativeTaskRef?.nativeId === "research",
        );
        assert.equal(subagent?.status, "completed");
        assert.equal(subagent?.result, "Resumed work finished.");
        assert.lengthOf(projection.runs, 1);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "claude-dropped-wake" },
            ProviderAdapterRegistry.layerSingle(observedAdapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  ),
);

it.effect.each(["provider switch", "cancel", "start failure"] as const)(
  "releases a queued buffered wake after %s and permits a later Claude completion",
  (action) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("claude-queued-wake");
        const sdkMessages = yield* Queue.unbounded<SDKMessage>();
        const dropped = yield* Queue.unbounded<void>();
        const offered = yield* Queue.unbounded<void>();
        let turnStarts = 0;
        let failQueuedStart = false;
        const registry = Layer.unwrap(
          Effect.gen(function* () {
            const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
            const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
              instanceId: modelSelection.instanceId,
              settings,
              environment: {},
              attachmentsDir: cwd,
              fileSystem: yield* FileSystem.FileSystem,
              path: yield* Path.Path,
              crypto: yield* Crypto.Crypto,
              idAllocator: yield* IdAllocator.IdAllocatorV2,
              continuationRequests: {
                offer: (request) =>
                  Effect.gen(function* () {
                    yield* Queue.offer(offered, undefined);
                    yield* requests.offer({
                      ...request,
                      clearIfCurrent: () =>
                        (request.clearIfCurrent?.() ?? Effect.void).pipe(
                          Effect.andThen(Queue.offer(dropped, undefined)),
                          Effect.asVoid,
                        ),
                    });
                  }),
              },
              queryRunner: {
                allocateSessionId: Effect.succeed(sessionId),
                open: () =>
                  Effect.succeed({
                    messages: Stream.fromQueue(sdkMessages),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: Effect.void,
                  }),
                forkSession: () => Effect.die("unused"),
                subagentLaunchToolUseId: () => Effect.succeed(null),
                assertComplete: Effect.void,
              },
            });
            const other = {
              ...adapter,
              instanceId: ProviderInstanceId.make("claude-other"),
              openSession: () => Effect.die("the wake must never start the other provider"),
            };
            return ProviderAdapterRegistry.layerFromAdapters([
              {
                ...adapter,
                getCapabilities: () =>
                  failQueuedStart
                    ? Effect.fail(
                        new ProviderAdapter.ProviderAdapterCapabilitiesError({
                          driver: adapter.driver,
                          cause: "Injected queued start failure.",
                        }),
                      )
                    : adapter.getCapabilities(),
                openSession: (input) =>
                  adapter.openSession(input).pipe(
                    Effect.map((runtime) => ({
                      ...runtime,
                      startTurn: (input) =>
                        Effect.suspend(() => {
                          turnStarts += 1;
                          return runtime.startTurn(input);
                        }),
                    })),
                  ),
              },
              other,
            ]);
          }),
        ).pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, IdAllocator.layer)),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sink = yield* EventSink.EventSinkV2;
          const threadId = ThreadId.make(`thread:queued-wake:${action}`);
          const watch = Effect.fnUntraced(function* (
            predicate: (event: OrchestrationV2DomainEvent) => boolean,
          ) {
            const afterSequence = yield* sink.latestSequence({ threadId });
            return yield* sink.stream({ threadId, afterSequence }).pipe(
              Stream.map((stored) => stored.event),
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-queued-wake"),
            threadId,
            projectId: ProjectId.make("project:queued-wake"),
            title: "Queued wake",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start-queued-wake"),
            threadId,
            messageId: MessageId.make("start-queued-wake"),
            text: "Start two background tasks.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(running);
          for (const taskId of ["first", "later"]) {
            const started = yield* watch(
              (event) =>
                event.type === "subagent.updated" &&
                event.payload.nativeTaskRef?.nativeId === taskId,
            );
            yield* Queue.offer(
              sdkMessages,
              frame({
                type: "system",
                subtype: "task_started",
                task_id: taskId,
                tool_use_id: taskId,
                description: taskId,
                task_type: "local_agent",
                subagent_type: "general-purpose",
                is_backgrounded: true,
                uuid: `start-${taskId}`,
                session_id: sessionId,
              }),
            );
            yield* Fiber.join(started);
          }
          const waiting = yield* watch(
            (event) => event.type === "run.updated" && event.payload.status === "waiting",
          );
          yield* Queue.offer(sdkMessages, result("queued-root-finished", false));
          yield* Fiber.join(waiting);
          // Leave checkpoint work pending so the real post-terminal root blocks the queue.
          const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          assert.equal(parent.status, "waiting");
          const queued = yield* watch(
            (event) =>
              (event.type === "run.created" || event.type === "run.updated") &&
              event.payload.status === "queued",
          );
          const complete = (taskId: string) =>
            Queue.offer(
              sdkMessages,
              frame({
                type: "system",
                subtype: "task_notification",
                task_id: taskId,
                tool_use_id: taskId,
                status: "completed",
                summary: `${taskId} finished`,
                output_file: `/tmp/${taskId}.output`,
                uuid: `done-${taskId}`,
                session_id: sessionId,
              }),
            );
          yield* complete("first");
          yield* Queue.take(offered);
          yield* Fiber.join(queued);
          const wake = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.status === "queued",
          )!;
          assert.ok(wake);
          assert.equal(turnStarts, 1);
          if (action === "cancel") {
            yield* orchestrator.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make("cancel-wake"),
              threadId,
              runId: wake.id,
            });
          } else {
            failQueuedStart = action === "start failure";
            if (action === "provider switch")
              yield* orchestrator.dispatch({
                type: "thread.model-selection.set",
                commandId: CommandId.make("switch-before-wake"),
                threadId,
                modelSelection: {
                  ...modelSelection,
                  instanceId: ProviderInstanceId.make("claude-other"),
                },
              });
            yield* sink.write({
              events: [
                {
                  id: EventId.make("finish-waiting-root"),
                  type: "run.updated",
                  threadId,
                  runId: parent.id,
                  occurredAt: yield* DateTime.now,
                  payload: { ...parent, status: "completed", completedAt: yield* DateTime.now },
                },
              ],
            });
            yield* orchestrator.resumeQueuedRuns;
            yield* worker.drain();
          }
          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            after.runs.find((run) => run.id === wake.id)?.status,
            action === "start failure" ? "failed" : "cancelled",
          );
          assert.equal(
            after.thread.modelSelection.instanceId,
            action === "provider switch" ? "claude-other" : modelSelection.instanceId,
          );
          assert.equal(turnStarts, 1);
          yield* Queue.take(dropped);
          yield* complete("later");
          yield* Queue.take(offered);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry({ name: "claude-queued-wake" }, registry, {
              runEffectWorker: false,
              runContinuationWorker: true,
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
);

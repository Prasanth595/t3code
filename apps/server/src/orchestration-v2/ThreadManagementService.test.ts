import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as TemporaryThreadDiagnostics from "../observability/TemporaryThreadDiagnostics.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as TemporaryThreadStorage from "./TemporaryThreadStorage.ts";
import * as TemporaryThreadService from "./TemporaryThreadService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { layerStorage } from "./runtimeLayer.ts";

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    // A client cannot claim a linked environment's origin, or a parent there.
    linkOrigin: { sessionId: "forged", label: "Somewhere else" },
    delegatedFrom: {
      environmentId: EnvironmentId.make("environment:elsewhere"),
      threadId: ThreadId.make("thread:elsewhere"),
      title: "Somewhere else",
    },
  };

  const stamped = ThreadManagementService.withCreationProvenance(command, {
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).not.toHaveProperty("linkOrigin");
  expect(stamped).not.toHaveProperty("delegatedFrom");
});

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const layerDispatchChokepointTest =
  (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) => (dispatched: Array<string>) =>
    ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: ThreadId.make("thread:thread-management:chokepoint"),
                projectId: ProjectId.make("project:thread-management:chokepoint"),
                deletedAt: null,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex_work"),
                  model: "test",
                },
              },
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(settingsLayer),
      Layer.provideMerge(layerReceiptsTest),
    );

it.effect(
  "the dispatch chokepoint refuses a continuation message.dispatch on a project-disabled instance before reaching the orchestrator",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-disabled");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("message:thread-management:chokepoint-disabled"),
          text: "Background task completed.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(error).toMatchObject({ projectId, instanceId });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "a replay of an already-accepted command id dispatches despite the instance now being disabled",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-replay");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });

      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-replay"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });

      expect(dispatched).toEqual(["message.dispatch"]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("waitForThread follows a restart continuation instead of the cut run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-restart");
    const threadId = ThreadId.make("thread:thread-management:wait-restart");
    const runId = RunId.make("run:thread-management:wait-restart");
    const continuationId = RunId.make("run:thread-management:wait-restart:2");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let runs: Array<{
      id: RunId;
      status: OrchestrationV2Run["status"];
      restartContinuationOfRunId?: RunId;
    }> = [{ id: runId, status: "cancelled" }];
    let pending = true;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          subscribeThreadRunUpdates: () =>
            Effect.succeed(
              Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                Stream.drain,
                Stream.concat(Stream.fromQueue(events).pipe(Stream.as(undefined))),
              ),
            ),
          restartContinuationPending: (run) => Effect.succeed(pending && run.id === runId),
          awaitRestartContinuation: () => Effect.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    const continuation = { id: continuationId, restartContinuationOfRunId: runId };
    runs = [...runs, { ...continuation, status: "running" }];
    pending = false;
    yield* Queue.offer(
      events,
      stored(1, { type: "run.updated", payload: { ...continuation, status: "running" } }),
    );
    runs = [runs[0]!, { ...continuation, status: "completed" }];
    yield* Queue.offer(
      events,
      stored(2, { type: "run.updated", payload: { ...continuation, status: "completed" } }),
    );
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: continuationId, status: "completed" },
    });
  }),
);

it.effect("waitForThread can wait past an ended run for the thread's delegated work", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-delegated");
    const threadId = ThreadId.make("thread:thread-management:wait-delegated");
    const runId = RunId.make("run:thread-management:wait-delegated");
    const wakeRunId = RunId.make("run:thread-management:wait-delegated:wake");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1_000);
    const run = (id: RunId, ordinal: number, status: OrchestrationV2Run["status"], end: number) =>
      ({
        id,
        ordinal,
        status,
        startedAt: at(end - 1),
        completedAt: status === "running" ? null : at(end),
      }) as unknown as OrchestrationV2Run;
    // The run ended, but a task it delegated still runs and will wake the thread.
    let runs = [run(runId, 1, "completed", 1)];
    let subagents = [{ status: "running" }];
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          delegatedTaskResultPending: () => Effect.succeed(false),
          subscribeThreadRunUpdates: (_id, includeDelegatedWork) =>
            Effect.succeed(
              Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                Stream.drain,
                Stream.concat(
                  Stream.fromQueue(events).pipe(
                    Stream.filter(
                      (stored) =>
                        includeDelegatedWork === true || stored.event.type === "run.updated",
                    ),
                    Stream.as(undefined),
                  ),
                ),
              ),
            ),
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                  messages: [],
                  subagents,
                  providerThreads: [],
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    // Without the option, the ended run is the answer, as before.
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).toMatchObject({ timedOut: false, run: { id: runId } });
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).not.toHaveProperty("resultRun");

    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60 * 60 * 1_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // A wait that returns early fails below instead of hanging here.
    yield* Effect.raceFirst(Deferred.await(subscribed), Fiber.await(fiber));
    // The task finishes; its delivery wakes the thread, whose next run answers.
    subagents = [{ status: "completed" }];
    runs = [...runs, run(wakeRunId, 2, "completed", 3)];
    yield* Queue.offer(events, stored(1, { type: "subagent.updated", payload: {} }));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "completed" },
      resultRun: { id: wakeRunId, status: "completed" },
    });
  }),
);

it.effect("waitForThread settles delegated work on a thread rolled back past its only run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-rolled-back");
    const threadId = ThreadId.make("thread:thread-management:wait-rolled-back");
    const runId = RunId.make("run:thread-management:wait-rolled-back");
    const rolledBack = {
      id: runId,
      ordinal: 1,
      status: "rolled_back",
      startedAt: DateTime.makeUnsafe(0),
      completedAt: DateTime.makeUnsafe(1_000),
    } as unknown as OrchestrationV2Run;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          delegatedTaskResultPending: () => Effect.succeed(false),
          subscribeThreadRunUpdates: () => Effect.succeed(Stream.never),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [rolledBack],
              messages: [],
              subagents: [],
              providerThreads: [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // Nothing will ever run there again, so a wait still open runs out here.
    yield* TestClock.adjust(Duration.millis(60_000));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "rolled_back" },
      resultRun: { id: runId, status: "rolled_back" },
    });
  }),
);

it.effect("waitForThread returns the cut run once its continuation is declined", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-declined");
    const threadId = ThreadId.make("thread:thread-management:wait-declined");
    const runId = RunId.make("run:thread-management:wait-declined");
    const subscribed = yield* Deferred.make<void>();
    const declined = yield* Deferred.make<void>();
    let pending = true;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          subscribeThreadRunUpdates: () =>
            Effect.succeed(
              Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                Stream.drain,
                Stream.concat(Stream.never),
              ),
            ),
          restartContinuationPending: () => Effect.succeed(pending),
          awaitRestartContinuation: () => Deferred.await(declined),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status: "cancelled" }],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    pending = false;
    yield* Deferred.succeed(declined, undefined);
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "cancelled" } });
  }),
);

it.effect.each(["live", "no-session", "unsupported-runtime"] as const)(
  "marks background work awaited on the thread's active provider thread with state %s",
  (state) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:background-wait");
      const providerThreadId = ProviderThreadId.make("provider-thread:background-wait");
      const providerSessionId = ProviderSessionId.make("provider-session:background-wait");
      const driver = ProviderDriverKind.make("claudeAgent");
      const now = yield* DateTime.now;
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [{ taskId: "tests", kind: "command" }],
        contextUsage: null,
        nativeMetadata: null,
        createdAt: now,
        updatedAt: now,
      };
      const calls: Array<{ providerThreadId: ProviderThreadId; awaited: boolean }> = [];
      const runtime = {
        driver,
        providerSessionId,
        ...(state === "unsupported-runtime"
          ? {}
          : {
              awaitBackgroundTasks: (input: {
                readonly providerThread: OrchestrationV2ProviderThread;
                readonly taskIds: ReadonlyArray<string>;
                readonly awaited: boolean;
              }) =>
                Effect.sync(() => {
                  calls.push({
                    providerThreadId: input.providerThread.id,
                    awaited: input.awaited,
                  });
                  return { matched: input.taskIds.filter((taskId) => taskId === "tests") };
                }),
            }),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: threadId,
                    deletedAt: null,
                    activeProviderThreadId: providerThreadId,
                  },
                  providerThreads: [providerThread],
                } as unknown as OrchestrationV2ThreadProjection),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Effect.succeed(state === "no-session" ? Option.none() : Option.some(runtime)),
            }),
          ),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const result = yield* Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        return yield* service
          .awaitBackgroundTasks({ threadId, taskIds: ["tests", "finished"], awaited: true })
          .pipe(Effect.result);
      }).pipe(Effect.provide(Layer.merge(layerTest, ThreadCommandExecutor.layer)));

      if (state === "live") {
        expect(result).toMatchObject({
          success: { matched: ["tests"], unmatched: ["finished"] },
        });
        expect(calls).toEqual([{ providerThreadId, awaited: true }]);
      } else {
        expect(result).toMatchObject({
          failure: {
            _tag: "ThreadManagementBackgroundWaitError",
            reason: state === "no-session" ? "unavailable" : "unsupported",
          },
        });
        expect(calls).toEqual([]);
      }
    }),
);

it.effect.each([
  { status: "completed" as const, settles: true },
  { status: "failed" as const, settles: false },
  { status: "interrupted" as const, settles: false },
])("settleAfterRun settles only when the run $status", ({ status, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const dispatched: Array<string> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          subscribeThreadRunUpdates: () => Effect.succeed(Stream.empty),
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.settleAfterRun({ projectId, threadId, runId });

    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);

const layerTemporaryCreateTest = ThreadManagementService.layerWithLegacyImporter.pipe(
  Layer.provideMerge(Orchestrator.layer),
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      IdAllocator.layer,
      ProviderContinuationRequests.layer,
      CommandPolicy.layer,
      RuntimePolicy.layer,
      ThreadForkService.layer,
      ServerSettings.layerTest(),
      Layer.mock(CheckpointService.CheckpointServiceV2)({}),
      Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
      Layer.mock(ProviderSwitchService.ProviderSwitchServiceV2)({}),
      ProviderAdapterRegistry.layerFromAdapters([
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
        } as ProviderAdapter.ProviderAdapterV2["Service"],
      ]),
      Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
        ensureTranscript: () => Effect.die("Create must not hydrate a transcript"),
      }),
    ),
  ),
  Layer.provideMerge(TemporaryThreadService.layerState),
  Layer.provideMerge(layerStorage.pipe(Layer.provide(SqlitePersistence.layerMemory))),
);

const temporaryCreateCommand = (threadId: ThreadId) => ({
  type: "thread.create" as const,
  threadId,
  temporary: true,
  commandId: CommandId.make(`${threadId}-create`),
  projectId: ProjectId.make("project:temporary"),
  title: "Temporary",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  createdBy: "user" as const,
  creationSource: "web" as const,
});

it.effect.each(
  ["missing-adapter", "rejected-replay", "command-conflict"].flatMap((failure) =>
    [false, true].map((reserved) => ({ failure, reserved })),
  ),
)("failed temporary create preserves reservation=$reserved for $failure", ({ failure, reserved }) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    const diagnostics = yield* TemporaryThreadDiagnostics.TemporaryThreadDiagnostics;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`temporary-management-${failure}-${reserved}`);
    const create = temporaryCreateCommand(threadId);
    if (reserved) yield* storage.register({ threadId });
    if (failure === "rejected-replay") {
      yield* sink.commitRejectedCommand({
        threadId,
        commandId: create.commandId,
        commandType: create.type,
        rejectedAt: yield* DateTime.now,
        error: "Previously rejected create",
      });
    } else if (failure === "command-conflict") {
      yield* threads.dispatch({ ...create, threadId: ThreadId.make("existing-create") });
      yield* storage.keep({
        threadId: ThreadId.make("existing-create"),
        commandId: CommandId.make("keep-existing-create"),
      });
    }
    const error = yield* threads
      .dispatch({
        ...create,
        ...(failure === "missing-adapter"
          ? {
              modelSelection: {
                ...create.modelSelection,
                instanceId: ProviderInstanceId.make("missing"),
              },
            }
          : {}),
      })
      .pipe(Effect.flip);
    expect(error._tag).toBe(
      failure === "missing-adapter"
        ? "OrchestratorDispatchError"
        : failure === "rejected-replay"
          ? "OrchestratorCommandPreviouslyRejectedError"
          : "OrchestratorCommandIdConflictError",
    );
    expect(yield* storage.isTemporary(threadId)).toBe(reserved);
    expect(yield* storage.isDiscarded(threadId)).toBe(false);
    expect(diagnostics.hasTemporaryThreads()).toBe(reserved);
    expect(diagnostics.canRecord()).toBe(!reserved);
    expect(yield* stores.durable.projectionStore.getThreadShell(threadId)).toBeNull();
    expect(yield* stores.volatile.projectionStore.getThreadShell(threadId)).toBeNull();
    if (failure === "missing-adapter") {
      expect(
        Option.isNone(yield* stores.durable.commandReceipts.getByCommandId(create.commandId)),
      ).toBe(true);
      expect(
        Option.isSome(yield* stores.volatile.commandReceipts.getByCommandId(create.commandId)),
      ).toBe(reserved);
    }
  }).pipe(Effect.provide(layerTemporaryCreateTest)),
);

it.effect.each([false, true])(
  "failed temporary transaction preserves reservation=%s and permits retry",
  (reserved) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
      const diagnostics = yield* TemporaryThreadDiagnostics.TemporaryThreadDiagnostics;
      const threadId = ThreadId.make("temporary-transaction-failure");
      const command = temporaryCreateCommand(threadId);
      if (reserved) yield* storage.register({ threadId });
      yield* stores.volatile
        .sql`CREATE TRIGGER reject_create BEFORE INSERT ON orchestration_v2_projection_threads BEGIN SELECT RAISE(ABORT, 'test create failure'); END`;
      const error = yield* threads.dispatch(command).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestratorDispatchError");
      expect(yield* storage.isTemporary(threadId)).toBe(reserved);
      expect(yield* storage.isDiscarded(threadId)).toBe(false);
      expect(diagnostics.hasTemporaryThreads()).toBe(reserved);
      expect(diagnostics.canRecord()).toBe(!reserved);
      for (const store of [stores.durable, stores.volatile]) {
        expect(yield* store.projectionStore.getThreadShell(threadId)).toBeNull();
        expect(Option.isNone(yield* store.commandReceipts.getByCommandId(command.commandId))).toBe(
          true,
        );
        expect(yield* store.sql`SELECT * FROM orchestration_events`).toEqual([]);
        expect(yield* store.sql`SELECT * FROM orchestration_v2_effect_outbox`).toEqual([]);
      }
      yield* stores.volatile.sql`DROP TRIGGER reject_create`;
      yield* threads.dispatch(command);
      expect((yield* stores.volatile.projectionStore.getThread(threadId)).temporary).toBe(true);
      expect(yield* stores.durable.projectionStore.getThreadShell(threadId)).toBeNull();
    }).pipe(Effect.provide(layerTemporaryCreateTest)),
);

it.effect("temporary create stays volatile through replay and becomes durable on Keep", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
    const stores = yield* TemporaryThreadStorage.TemporaryThreadStores;
    const diagnostics = yield* TemporaryThreadDiagnostics.TemporaryThreadDiagnostics;
    const threadId = ThreadId.make("temporary-management-keep");
    const create = temporaryCreateCommand(threadId);
    const accepted = yield* threads.dispatch(create);
    expect(yield* threads.dispatch(create)).toMatchObject({ ...accepted, replayed: true });
    expect(diagnostics.canRecord()).toBe(false);
    for (const table of [
      "orchestration_events",
      "orchestration_command_receipts",
      "orchestration_v2_projection_threads",
      "orchestration_v2_effect_outbox",
    ]) {
      expect(yield* stores.durable.sql.unsafe(`SELECT * FROM ${table}`)).toEqual([]);
    }
    expect((yield* stores.volatile.projectionStore.getThread(threadId)).temporary).toBe(true);
    yield* storage.keep({ threadId, commandId: CommandId.make("keep-management") });
    yield* threads.dispatch(create);
    expect((yield* stores.durable.projectionStore.getThread(threadId)).id).toBe(threadId);
    expect(yield* storage.isTemporary(threadId)).toBe(false);
    expect(diagnostics.canRecord()).toBe(true);
  }).pipe(Effect.provide(layerTemporaryCreateTest)),
);

it.effect.each(
  [false, true].flatMap((rejected) => [false, true].map((discarded) => ({ rejected, discarded }))),
)(
  "closed temporary family refuses receipt replay with rejection=$rejected, discarded=$discarded",
  ({ rejected, discarded }) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make(`temporary-management-closed-${rejected}`);
      const create = temporaryCreateCommand(threadId);
      yield* threads.dispatch(create);
      const command = rejected
        ? { ...create, commandId: CommandId.make("closed-rejected") }
        : create;
      if (rejected)
        yield* sink.commitRejectedCommand({
          threadId,
          commandId: command.commandId,
          commandType: command.type,
          rejectedAt: yield* DateTime.now,
          error: "Prior rejection",
        });
      const lifecycle = yield* TemporaryThreadService.TemporaryThreadLifecycleState;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      expect(Option.isSome(yield* receipts.getByCommandId(command.commandId))).toBe(true);
      if (discarded) yield* storage.discard(threadId);
      else {
        lifecycle.discarding.add(threadId);
        yield* storage.markDiscarding(threadId);
        expect(Option.isSome(yield* receipts.getByCommandId(command.commandId))).toBe(true);
      }
      const error = yield* threads.dispatch(command).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestratorDispatchError",
        cause: "Temporary thread is closed.",
      });
      expect(yield* storage.isDiscarded(threadId)).toBe(discarded);
    }).pipe(Effect.provide(layerTemporaryCreateTest)),
);

const createWaitThread = Effect.fn("test.createWaitThread")(function* (threadId: ThreadId) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make("create-" + threadId),
        threadId,
        type: "thread.created",
        occurredAt: now,
        payload: {
          id: threadId,
          createdBy: "user",
          creationSource: "web",
          projectId: ProjectId.make("wait-project"),
          title: "wait fixture",
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      },
    ],
  });
});

it.effect.each([
  { method: "waitForThread" as const, memoryAhead: true, completeBeforeKeep: false },
  { method: "waitForThread" as const, memoryAhead: false, completeBeforeKeep: false },
  { method: "settleAfterRun" as const, memoryAhead: true, completeBeforeKeep: false },
  { method: "settleAfterRun" as const, memoryAhead: false, completeBeforeKeep: false },
  { method: "waitForThread" as const, memoryAhead: true, completeBeforeKeep: true },
  { method: "settleAfterRun" as const, memoryAhead: true, completeBeforeKeep: true },
])(
  "$method sees completion when Keep wins before subscription, memoryAhead=$memoryAhead, completeBeforeKeep=$completeBeforeKeep",
  ({ method, memoryAhead, completeBeforeKeep }) =>
    Effect.gen(function* () {
      const storage = yield* TemporaryThreadStorage.TemporaryThreadStorage;
      const sink = yield* EventSink.EventSinkV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const projectId = ProjectId.make("wait-project");
      const threadId = ThreadId.make("wait-target");
      const fillerId = ThreadId.make("wait-filler");
      const runId = RunId.make("wait-run");
      const now = yield* DateTime.now;
      if (memoryAhead) yield* storage.register({ threadId: fillerId });
      yield* createWaitThread(fillerId);
      const filler = yield* projection.getThread(fillerId);
      yield* sink.write({
        events: Array.from({ length: 8 }, (_, index) => ({
          id: EventId.make("filler-" + index),
          threadId: fillerId,
          type: "thread.metadata-updated" as const,
          occurredAt: now,
          payload: filler,
        })),
      });
      yield* storage.register({ threadId });
      yield* createWaitThread(threadId);
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        providerThreadId: null,
        userMessageId: MessageId.make("wait-message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("running-created"),
            threadId,
            type: "run.created",
            occurredAt: now,
            payload: run,
          },
          {
            id: EventId.make("running-update"),
            threadId,
            type: "run.updated",
            occurredAt: now,
            payload: run,
          },
        ],
      });
      const memoryCursor = yield* sink.latestSequence({ threadId });
      const snapshotRead = yield* Deferred.make<void>();
      const resumeRead = yield* Deferred.make<void>();
      const observed: Array<EventId> = [];
      let firstRead = true;
      let completionSequence = 0;
      const observe = (stream: Stream.Stream<OrchestrationV2StoredEvent, unknown>) =>
        stream.pipe(
          Stream.tap((stored) =>
            Effect.sync(() => {
              if (stored.event.type === "run.updated") observed.push(stored.event.id);
            }),
          ),
          Stream.orDie,
        );
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
            ServerSettings.layerTest(),
            Layer.succeed(CommandReceiptStore.CommandReceiptStoreV2, receipts),
            Layer.mock(Orchestrator.OrchestratorV2)({
              subscribeThreadRunUpdates: (id, includeDelegatedWork) =>
                storage.subscribeThreadRunUpdates(id, includeDelegatedWork).pipe(
                  Effect.map((updates) => updates.pipe(Stream.orDie)),
                  Effect.orDie,
                ),
              getThreadEventSequence: (id) =>
                sink.latestSequence({ threadId: id }).pipe(Effect.orDie),
              streamStoredEventsFrom: (input) =>
                Stream.unwrap(
                  Effect.sync(() => {
                    expect(input?.afterSequence ?? 0).toBeLessThan(completionSequence);
                    return observe(sink.stream(input));
                  }),
                ),
              restartContinuationPending: () => Effect.succeed(false),
              getThreadRecords: (id, fields, filter) =>
                Effect.gen(function* () {
                  const records = yield* projection.getThreadRecords(id, fields, filter);
                  if (firstRead) {
                    firstRead = false;
                    yield* Deferred.succeed(snapshotRead, undefined);
                    yield* Deferred.await(resumeRead);
                  }
                  return records;
                }).pipe(Effect.orDie),
              dispatch: (command) =>
                Effect.gen(function* () {
                  expect(command.type).toBe("thread.settle");
                  const current = yield* projection.getThread(threadId);
                  const storedEvents = yield* sink.write({
                    events: [
                      {
                        id: EventId.make("settled"),
                        threadId,
                        type: "thread.settled",
                        occurredAt: now,
                        payload: { ...current, settledOverride: "settled", settledAt: now },
                      },
                    ],
                  });
                  return { sequence: storedEvents.at(-1)!.sequence, storedEvents };
                }).pipe(Effect.orDie),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        const waiter = yield* (
          method === "waitForThread"
            ? service.waitForThread({ projectId, threadId, runId, timeoutMs: 60_000 })
            : service.settleAfterRun({ projectId, threadId, runId })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(snapshotRead);
        const complete = sink.write({
          events: [
            {
              id: EventId.make("actual-completion"),
              threadId,
              type: "run.updated",
              occurredAt: now,
              payload: { ...run, status: "completed", completedAt: now },
            },
          ],
        });
        if (completeBeforeKeep) yield* complete;
        yield* storage.keep({ threadId, commandId: CommandId.make("keep-during-read") });
        if (!completeBeforeKeep) yield* complete;
        completionSequence = yield* sink.latestSequence({ threadId });
        expect(
          memoryAhead ? memoryCursor > completionSequence : memoryCursor < completionSequence,
        ).toBe(true);
        yield* Deferred.succeed(resumeRead, undefined);
        const result = yield* Fiber.join(waiter);
        if (method === "waitForThread")
          expect(result).toMatchObject({
            timedOut: false,
            run: { id: runId, status: "completed" },
          });
        else expect((yield* projection.getThread(threadId)).settledOverride).toBe("settled");
        expect(observed).not.toContain("running-update");
      }).pipe(Effect.provide(layerTest));
    }).pipe(Effect.provide(layerStorage.pipe(Layer.provide(SqlitePersistence.layerMemory)))),
);

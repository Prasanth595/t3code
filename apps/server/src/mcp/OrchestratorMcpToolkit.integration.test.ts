import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  isProviderNativeSubagentThread,
  MessageId,
  NodeId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadSendResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  ProviderThreadId,
  ProviderTurnId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "@t3tools/provider-testing/replayTranscript";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const codexInstanceId = ProviderInstanceId.make("codex");
const codexModel = "gpt-5.4";
const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const queuedFollowupPrompt = "Complete the queued follow-up and return the final result.";
const queuedFollowupResult = "Queued delegated follow-up completed.";

const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeTaskCancelResult = Schema.decodeUnknownEffect(OrchestratorMcpTaskCancelResult);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const delegatedTaskStatusTranscriptFile = new URL(
  "../orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson",
  import.meta.url,
);

const readDelegatedTaskStatusTranscript = Effect.fn("readDelegatedTaskStatusTranscript")(function* (
  followupResult: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(
    decodeURIComponent(delegatedTaskStatusTranscriptFile.pathname),
  );
  return yield* decodeProviderReplayNdjson(text.replaceAll(queuedFollowupResult, followupResult));
}, Effect.provide(NodeServices.layer));

interface CapturedTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
}

function unsupported(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
}

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

function makeDeterministicAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly shouldComplete: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => boolean;
  readonly terminalGate?: (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) => Deferred.Deferred<void> | undefined;
  readonly response: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => string;
  readonly allowFork?: boolean;
  readonly beforeInterrupt?: Effect.Effect<void>;
  readonly steerReceived?: (
    steer: ProviderAdapter.ProviderAdapterV2SteerInput,
  ) => Deferred.Deferred<void> | undefined;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const publish = (providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const runOrdinals = new Map<ProviderTurnId, number>();
        const turnInputs = new Map<ProviderTurnId, ProviderAdapter.ProviderAdapterV2TurnInput>();

        return {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  instanceId: input.instanceId,
                  threadId: turnInput.threadId,
                  text: turnInput.message.text,
                  modelSelection: turnInput.modelSelection,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              runOrdinals.set(providerTurnId, turnInput.runOrdinal);
              turnInputs.set(providerTurnId, turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "running",
                    startedAt: eventTime,
                    completedAt: null,
                  },
                },
              ]);
              const terminalGate = input.terminalGate?.(turnInput);
              if (terminalGate !== undefined) {
                yield* Deferred.await(terminalGate);
              } else if (!input.shouldComplete(turnInput)) {
                return;
              }
              const response = input.response(turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: (steer) => {
            const received = input.steerReceived?.(steer);
            return received === undefined
              ? Effect.void
              : Deferred.succeed(received, undefined).pipe(Effect.asVoid);
          },
          interruptTurn: ({ providerThread, providerTurnId }) =>
            Effect.gen(function* () {
              yield* input.beforeInterrupt ?? Effect.void;
              const turnInput = turnInputs.get(providerTurnId);
              const completedAt = yield* DateTime.now;
              if (turnInput !== undefined) {
                yield* publish([
                  {
                    type: "provider_turn.updated",
                    driver: input.driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: providerThread.id,
                      nodeId: turnInput.rootNodeId,
                      runAttemptId: turnInput.attemptId,
                      nativeTurnRef: {
                        driver: input.driver,
                        nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                        strength: "strong",
                      },
                      ordinal: turnInput.providerTurnOrdinal,
                      status: "interrupted",
                      startedAt: completedAt,
                      completedAt,
                    },
                  },
                ]);
              }
              yield* publish([
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: providerThread.id,
                  providerTurnId,
                  runOrdinal: runOrdinals.get(providerTurnId) ?? 1,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            unsupported(input.driver, "readThreadSnapshot is unused in this test"),
          rollbackThread: () => unsupported(input.driver, "rollbackThread is unused in this test"),
          forkThread: (fork) =>
            input.allowFork
              ? Effect.succeed({
                  ...fork.sourceProviderThread,
                  id: ProviderThreadId.make(`fork:${fork.targetThreadId}`),
                  providerSessionId: sessionInput.providerSessionId,
                  appThreadId: fork.targetThreadId,
                  nativeThreadRef: {
                    driver: input.driver,
                    nativeId: `fork:${fork.targetThreadId}`,
                    strength: "strong" as const,
                  },
                })
              : unsupported(input.driver, "forkThread is unused in this test"),
        };
      }),
  };
}

function waitForProjection(
  orchestrator: Orchestrator.OrchestratorV2Shape,
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  // Re-read the projection after every stored event instead of polling the clock.
  return orchestrator.streamStoredEventsFrom({ afterSequence: 0 }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    Stream.filter(predicate),
    Stream.runHead,
  );
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerMemorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = stored.get(name);
        if (existing) return existing;
        const value = new Uint8Array(bytes).fill(7);
        stored.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

const layerUnusedScheduledTaskStub = Layer.succeed(
  ScheduledTaskService.ScheduledTaskService,
  ScheduledTaskService.ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [] }),
    subscribeList: () => Stream.succeed({ tasks: [] }),
    upsert: () => Effect.die("ScheduledTaskService.upsert is unused in this test"),
    setEnabled: () => Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
    delete: () => Effect.die("ScheduledTaskService.delete is unused in this test"),
    deleteForThread: () => Effect.die("unused in this test"),
    runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
    rotateWebhookToken: () => Effect.die("unused in this test"),
    listWebhookDeliveries: () => Effect.die("unused in this test"),
    getWebhookDelivery: () => Effect.die("unused in this test"),
    triggerWebhook: () => Effect.die("unused in this test"),
  }),
);

// Uses the real command processor, effect worker and registered MCP transport.
const governedLimits = { maxDepth: 1 as const, maxActive: 2, maxTotal: 3 };
const policyToolkitLayer = (
  registry: Layer.Layer<ProviderAdapterRegistry.ProviderAdapterRegistryV2>,
  cwd: string,
  database: typeof SqlitePersistence.layerMemory,
) => {
  const harness = ProviderReplayHarness.layerWithRegistry(
    { name: "governed-toolkit", runtimePolicyOverride: { cwd, approvalPolicy: "never" } },
    registry,
    { databaseLayer: database, delegationPolicy: governedLimits },
  );
  const orchestration = Layer.merge(
    harness,
    ThreadManagementService.layer.pipe(
      Layer.provide(harness),
      Layer.provide(ServerSettings.layerTest({ delegationPolicy: governedLimits })),
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
    ),
  );
  return layerOrchestratorToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(
      Layer.merge(ProjectionStore.layer.pipe(Layer.provide(database)), orchestration),
    ),
    Layer.provide(registry),
    Layer.provide(
      ProviderRegistryMock.layer([
        makeProviderSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: codexModel,
        }),
      ]),
    ),
    Layer.provide(ServerSettings.layerTest({ delegationPolicy: governedLimits })),
    Layer.provide(layerUnusedScheduledTaskStub),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(
      SecretRequests.layer.pipe(
        Layer.provide(layerMemorySecretStore),
        Layer.provide(orchestration),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
};

const createPolicyRoot = (threadId: ThreadId, cwd: string) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Policy root",
      modelSelection: codexSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    }),
  );
const policyMessage = (threadId: ThreadId, id: string, text: string, queued = false) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId,
      messageId: MessageId.make(id),
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
    }),
  );
const policyRequest = (threadId: ThreadId, id: string, task = cancellationPrompt) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    Effect.gen(function* () {
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const run = projection.runs.at(-1)!;
      return yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make(id),
        parentThreadId: threadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task,
        modelSelection: codexSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
    }),
  );
const awaitPolicyEvent = (
  threadId: ThreadId,
  predicate: (event: OrchestrationV2DomainEvent) => boolean,
) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: 0 }).pipe(
      Stream.filter((stored) => predicate(stored.event)),
      Stream.runHead,
    ),
  );
const invokePolicyTool = (threadId: ThreadId, name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.use((server) =>
    server.callTool({ name, arguments: args }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("policy-test"),
        requestNamespace: "policy-test",
        thread: { threadId, providerSessionId: "policy-test", providerInstanceId: codexInstanceId },
        client: undefined,
        capabilities: new Set(["orchestration"] as const),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    ),
  );

it.live("governed completion and UI followups count children across root forks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("governed-budget");
      const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const registry = ProviderAdapterRegistry.layerFromAdapters([
        makeDeterministicAdapter({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          capabilities: CodexProviderCapabilitiesV2,
          capturedTurns,
          allowFork: true,
          shouldComplete: (turn) => turn.message.text === "complete",
          response: () => "Complete.",
        }),
      ]);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const database = Layer.succeed(SqlClient.SqlClient, sql);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const sink = yield* EventSink.EventSinkV2;
          // Replay real persisted events into the memory implementation at every budget checkpoint.
          const budget = (expected: { active: number; total: number }) =>
            Effect.gen(function* () {
              expect(yield* store.getDelegationBudget(parentThreadId)).toEqual(expected);
              const memory = yield* Effect.service(ProjectionStore.ProjectionStoreV2).pipe(
                Effect.provide(ProjectionStore.layerMemory),
              );
              const through = yield* sink.latestSequence();
              yield* sink.stream({ afterSequence: 0 }).pipe(
                Stream.takeUntil((stored) => stored.sequence >= through),
                Stream.runForEach((stored) => memory.apply(stored.event)),
              );
              expect(yield* memory.getDelegationBudget(parentThreadId)).toEqual(expected);
            });
          yield* createPolicyRoot(parentThreadId, cwd);
          yield* policyMessage(parentThreadId, "root-complete", "complete");
          yield* awaitPolicyEvent(
            parentThreadId,
            (e) => e.type === "run.updated" && e.payload.status === "completed",
          );
          const rootFork = ThreadId.make("policy-root-fork");
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("fork-root"),
            sourceThreadId: parentThreadId,
            targetThreadId: rootFork,
            sourcePoint: { type: "latest_stable" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* policyMessage(parentThreadId, "root-hold", cancellationPrompt);
          yield* policyMessage(rootFork, "fork-hold", cancellationPrompt);
          yield* policyRequest(parentThreadId, "completed-child", "complete");
          yield* awaitPolicyEvent(
            parentThreadId,
            (e) => e.type === "subagent.updated" && e.payload.status === "completed",
          );
          const completed = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
          const child = completed.childThreadId!;
          yield* budget({ active: 0, total: 1 });
          const childFork = ThreadId.make("policy-child-fork");
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("fork-child"),
            sourceThreadId: child,
            targetThreadId: childFork,
            sourcePoint: { type: "latest_stable" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* policyMessage(childFork, "child-fork-hold", cancellationPrompt);
          yield* awaitPolicyEvent(
            childFork,
            (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
          );
          const before = yield* sink.latestSequence();
          const denied = yield* policyRequest(childFork, "fork-child-denied").pipe(Effect.result);
          expect(Result.isFailure(denied) && denied.failure).toMatchObject({
            _tag: "DelegationPolicyError",
            code: "delegation_depth_exceeded",
          });
          expect(yield* sink.latestSequence()).toBe(before);
          yield* policyMessage(child, "followup-running", cancellationPrompt);
          const followupNode = (yield* orchestrator.getThreadProjection(child)).runs.at(
            -1,
          )!.rootNodeId;
          yield* awaitPolicyEvent(
            child,
            (e) =>
              e.type === "provider-turn.updated" &&
              e.payload.status === "running" &&
              e.payload.nodeId === followupNode,
          );
          yield* policyMessage(child, "followup-queued-one", cancellationPrompt, true);
          yield* policyMessage(child, "followup-queued-two", cancellationPrompt, true);
          expect(
            (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.length,
          ).toBeGreaterThan(1);
          yield* budget({ active: 1, total: 1 });
          const concurrent = yield* Effect.forEach(
            [parentThreadId, rootFork, rootFork],
            (id, index) => policyRequest(id, `shared-${index}`).pipe(Effect.result),
            { concurrency: 3 },
          );
          expect(concurrent.filter(Result.isSuccess)).toHaveLength(1);
          for (const result of concurrent.filter(Result.isFailure))
            expect(result.failure).toMatchObject({ code: "delegation_budget_exceeded" });
          yield* budget({ active: 2, total: 2 });
          const status = yield* invokePolicyTool(parentThreadId, "task_status", {
            taskId: completed.id,
          });
          expect(status.isError).toBe(false);
          const followupTask = (yield* orchestrator.getThreadProjection(
            parentThreadId,
          )).subagents.find((task) => task.childThreadId === child && task.id !== completed.id)!;
          const cancel = yield* invokePolicyTool(parentThreadId, "task_cancel", {
            taskId: followupTask.id,
          });
          expect(cancel.isError).toBe(false);
          yield* awaitPolicyEvent(
            child,
            (e) => e.type === "run.updated" && e.payload.status === "interrupted",
          );
          // Stop holds other queued followups for Resume; cancel each task to release that child.
          for (const task of (yield* orchestrator.getThreadProjection(parentThreadId)).subagents) {
            if (
              task.childThreadId === child &&
              task.id !== completed.id &&
              task.id !== followupTask.id
            ) {
              expect(
                (yield* invokePolicyTool(parentThreadId, "task_cancel", { taskId: task.id }))
                  .isError,
              ).toBe(false);
            }
          }
          yield* sink.stream({ threadId: parentThreadId, afterSequence: 0 }).pipe(
            Stream.mapEffect(() => store.getDelegationBudget(parentThreadId)),
            Stream.filter((current) => current.active === 1),
            Stream.runHead,
          );
          yield* budget({ active: 1, total: 2 });
          yield* policyRequest(rootFork, "last-launch");
          yield* budget({ active: 2, total: 3 });
          const lastTask = (yield* orchestrator.getThreadProjection(rootFork)).subagents.at(-1)!;
          expect(
            (yield* invokePolicyTool(rootFork, "task_cancel", { taskId: lastTask.id })).isError,
          ).toBe(false);
          yield* sink.stream({ threadId: rootFork, afterSequence: 0 }).pipe(
            Stream.mapEffect(() => store.getDelegationBudget(parentThreadId)),
            Stream.filter((current) => current.active === 1),
            Stream.runHead,
          );
          yield* budget({ active: 1, total: 3 });
          const exhausted = yield* policyRequest(parentThreadId, "fork-shared-total-denied").pipe(
            Effect.result,
          );
          expect(Result.isFailure(exhausted) && exhausted.failure).toMatchObject({
            code: "delegation_budget_exceeded",
          });
          // Legacy rows without backing children consume neither budget, in either store.
          yield* sink.write({
            events: [
              {
                id: EventId.make("policy-null-child"),
                type: "subagent.updated",
                threadId: parentThreadId,
                occurredAt: completed.updatedAt,
                payload: {
                  ...completed,
                  id: NodeId.make("policy-null-child"),
                  childThreadId: null,
                  status: "running",
                  result: null,
                },
              },
            ],
          });
          yield* budget({ active: 1, total: 3 });
        }).pipe(Effect.provide(policyToolkitLayer(registry, cwd, database)));
      }).pipe(Effect.provide(SqlitePersistence.layerMemory));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "governed registered status and cancel recursively stop preexisting same-mode grandchildren",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("governed-cancel");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const registry = ProviderAdapterRegistry.layerFromAdapters([
          makeDeterministicAdapter({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            capabilities: CodexProviderCapabilitiesV2,
            capturedTurns,
            shouldComplete: () => false,
            response: () => "unused",
          }),
        ]);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const database = Layer.succeed(SqlClient.SqlClient, sql);
          // Create legitimate nested records while unrestricted, then start the governed worker.
          const { child, grandchild, taskId } = yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* createPolicyRoot(parentThreadId, cwd);
            yield* policyMessage(parentThreadId, "legacy-root", cancellationPrompt);
            yield* policyRequest(parentThreadId, "legacy-child");
            const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
            const child = task.childThreadId!;
            yield* policyRequest(child, "legacy-grandchild");
            const grandchild = (yield* orchestrator.getThreadProjection(child)).subagents[0]!
              .childThreadId!;
            return { child, grandchild, taskId: task.id };
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry({ name: "preexisting-nesting" }, registry, {
                databaseLayer: database,
                runEffectWorker: false,
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            for (const id of [child, grandchild])
              yield* awaitPolicyEvent(
                id,
                (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
              );
            expect((yield* Ref.get(capturedTurns)).map((turn) => turn.threadId)).toEqual(
              expect.arrayContaining([child, grandchild]),
            );
            const status = yield* invokePolicyTool(parentThreadId, "task_status", { taskId });
            expect(status.isError).toBe(false);
            const cancel = yield* invokePolicyTool(parentThreadId, "task_cancel", { taskId });
            expect(cancel.isError).toBe(false);
            const decoded = yield* decodeTaskCancelResult(cancel.structuredContent);
            expect(decoded.taskId).toBe(taskId);
            for (const id of [child, grandchild]) {
              yield* awaitPolicyEvent(
                id,
                (e) => e.type === "run.updated" && e.payload.status === "interrupted",
              );
              const projection = yield* orchestrator.getThreadProjection(id);
              expect(
                projection.runs.every((run) => ["interrupted", "cancelled"].includes(run.status)),
              ).toBe(true);
            }
            expect(
              (yield* invokePolicyTool(parentThreadId, "task_status", { taskId })).isError,
            ).toBe(false);
            yield* orchestrator.streamStoredEventsFrom({ afterSequence: 0 }).pipe(
              Stream.mapEffect(() =>
                ProjectionStore.ProjectionStoreV2.use((store) =>
                  store.getDelegationBudget(parentThreadId),
                ),
              ),
              Stream.filter((b) => b.active === 0),
              Stream.runHead,
            );
            expect(
              yield* (yield* ProjectionStore.ProjectionStoreV2).getDelegationBudget(parentThreadId),
            ).toEqual({ active: 0, total: 2 });
          }).pipe(Effect.provide(policyToolkitLayer(registry, cwd, database)));
        }).pipe(Effect.provide(SqlitePersistence.layerMemory));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["starting", "running"] as const)(
  "archiving a governed %s child retains budget until native cancellation",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`governed-archive-${state}`);
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const interruptStarted = yield* Deferred.make<void>();
        const allowInterrupt = yield* Deferred.make<void>();
        const registry = ProviderAdapterRegistry.layerFromAdapters([
          makeDeterministicAdapter({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            capabilities: CodexProviderCapabilitiesV2,
            capturedTurns,
            shouldComplete: () => false,
            response: () => "unused",
            beforeInterrupt: Deferred.succeed(interruptStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowInterrupt)),
            ),
          }),
        ]);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const database = Layer.succeed(SqlClient.SqlClient, sql);
          const child = yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const store = yield* ProjectionStore.ProjectionStoreV2;
            yield* createPolicyRoot(parentThreadId, cwd);
            yield* policyMessage(parentThreadId, "archive-root", cancellationPrompt);
            yield* policyRequest(parentThreadId, "archive-child");
            const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
            expect(yield* store.getDelegationBudget(parentThreadId)).toEqual({
              active: 1,
              total: 1,
            });
            if (state === "starting") {
              yield* orchestrator.dispatch({
                type: "thread.archive",
                commandId: CommandId.make("archive-queued-child"),
                threadId: task.childThreadId!,
              });
              expect(yield* store.getDelegationBudget(parentThreadId)).toEqual({
                active: 1,
                total: 1,
              });
              expect(yield* Ref.get(capturedTurns)).toEqual([]);
            }
            return task.childThreadId!;
          }).pipe(
            Effect.provide(
              Layer.merge(
                ProjectionStore.layer.pipe(Layer.provide(database)),
                ProviderReplayHarness.layerWithRegistry({ name: `archive-${state}` }, registry, {
                  databaseLayer: database,
                  runEffectWorker: false,
                  delegationPolicy: governedLimits,
                }),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const store = yield* ProjectionStore.ProjectionStoreV2;
            if (state === "running") {
              yield* awaitPolicyEvent(
                child,
                (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
              );
              yield* policyMessage(child, "archive-queued-followup", cancellationPrompt, true);
              expect(
                (yield* orchestrator.getThreadProjection(child)).runs.some(
                  (run) => run.status === "queued",
                ),
              ).toBe(true);
              yield* orchestrator.dispatch({
                type: "thread.archive",
                commandId: CommandId.make("archive-running-child"),
                threadId: child,
              });
              yield* Deferred.await(interruptStarted);
              expect(yield* store.getDelegationBudget(parentThreadId)).toEqual({
                active: 1,
                total: 1,
              });
              yield* Deferred.succeed(allowInterrupt, undefined);
              yield* waitForProjection(orchestrator, parentThreadId, (p) =>
                p.subagents.every((t) => ["cancelled", "interrupted", "failed"].includes(t.status)),
              );
              const projection = yield* orchestrator.getThreadProjection(child);
              expect(
                projection.runs.every((run) =>
                  ["cancelled", "interrupted", "failed"].includes(run.status),
                ),
              ).toBe(true);
            }
            if (state === "starting") {
              // Archive does not cancel an already accepted provider-start effect.
              yield* awaitPolicyEvent(
                child,
                (e) => e.type === "provider-turn.updated" && e.payload.status === "running",
              );
              expect(yield* store.getDelegationBudget(parentThreadId)).toEqual({
                active: 1,
                total: 1,
              });
              yield* Deferred.succeed(allowInterrupt, undefined);
              const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
              expect(
                (yield* invokePolicyTool(parentThreadId, "task_cancel", { taskId: task.id }))
                  .isError,
              ).toBe(false);
              yield* waitForProjection(orchestrator, parentThreadId, (p) =>
                p.subagents.every((t) => ["cancelled", "interrupted", "failed"].includes(t.status)),
              );
            }
            expect(yield* store.getDelegationBudget(parentThreadId)).toEqual({
              active: 0,
              total: 1,
            });
            const memory = yield* Effect.service(ProjectionStore.ProjectionStoreV2).pipe(
              Effect.provide(ProjectionStore.layerMemory),
            );
            const sink = yield* EventSink.EventSinkV2;
            const through = yield* sink.latestSequence();
            yield* sink.stream({ afterSequence: 0 }).pipe(
              Stream.takeUntil((stored) => stored.sequence >= through),
              Stream.runForEach((stored) => memory.apply(stored.event)),
            );
            expect(yield* memory.getDelegationBudget(parentThreadId)).toEqual({
              active: 0,
              total: 1,
            });
          }).pipe(Effect.provide(policyToolkitLayer(registry, cwd, database)));
        }).pipe(Effect.provide(SqlitePersistence.layerMemory));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

describe("orchestrator MCP toolkit", () => {
  it.live.each([
    { label: "distinct", result: queuedFollowupResult, latestSummary: queuedFollowupResult },
    { label: "identical", result: delegatedResult, latestSummary: null },
  ])("reports $label child results", ({ result, latestSummary }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("delegated-task-status");
        const rawTranscript = yield* readDelegatedTaskStatusTranscript(result);
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(rawTranscript, cwd),
        );
        const layerOrchestrator = ProviderReplayHarness.layerProviderReplay(
          {
            name: "delegated-task-status/codex",
            transcript,
            commands: [],
            runtimePolicyOverride: { cwd },
          },
          CodexOrchestratorReplayHarness,
        );
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const layerProviderRegistry = ProviderRegistryMock.layer([
          makeProviderSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: codexModel,
          }),
        ]);
        const layerTest = layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(layerOrchestration),
          Layer.provide(
            CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript).pipe(
              Layer.provide(McpProviderSessions.layer),
            ),
          ),
          Layer.provide(layerProviderRegistry),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(layerUnusedScheduledTaskStub),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provideMerge(
            SecretRequests.layer.pipe(
              Layer.provide(layerMemorySecretStore),
              Layer.provide(layerOrchestration),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const server = yield* McpServer.McpServer;
          const parentCreate = yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "MCP replay parent",
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:mcp-replay-parent:start"),
            text: parentPrompt,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: parentCreate.sequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Parent provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const invocation: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:mcp-replay"),
            requestNamespace: "mcp-provider-session-replay-parent",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "mcp-provider-session-replay-parent",
              providerInstanceId: codexInstanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const invoke = (name: string, args: Record<string, unknown>) =>
            server
              .callTool({ name, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
                Effect.provideService(McpSchema.McpServerClient, client),
              );

          const delegationStartSequence =
            yield* orchestrator.getThreadEventSequence(parentThreadId);
          const delegatedCall = yield* invoke("delegate_task", {
            task: delegatedPrompt,
            target: {
              providerInstanceId: codexInstanceId,
              model: codexModel,
            },
            mode: "async",
            clientRequestId: "delegate-codex-replay-1",
          });
          const delegatedStart = yield* decodeDelegateTaskResult(
            delegatedCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegatedStart.childRunId).not.toBeNull();
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: delegationStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "context-transfer.created" &&
                  stored.event.payload.type === "subagent_result" &&
                  stored.event.payload.sourceThreadId === delegatedStart.childThreadId &&
                  stored.event.payload.sourcePoint.runId === delegatedStart.childRunId,
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Delegated result transfer was not created."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const delegatedStatusCall = yield* invoke("task_status", {
            taskId: delegatedStart.taskId,
          });
          const delegated = yield* decodeDelegateTaskResult(
            delegatedStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegated).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            providerInstanceId: codexInstanceId,
            hasPendingChildRuns: false,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });
          expect(delegated.resultContextTransferId).not.toBeNull();

          const delegatedChild = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(delegatedChild.thread.lineage.relationshipToParent).toBe("subagent");
          expect(isProviderNativeSubagentThread(delegatedChild.thread)).toBe(false);
          const followupStartSequence = yield* orchestrator.getThreadEventSequence(
            delegated.childThreadId,
          );
          const runningFollowupCall = yield* invoke("t3_thread_send", {
            threadId: delegated.childThreadId,
            message: cancellationPrompt,
            clientRequestId: "delegated-child-replay-running-1",
          });
          const runningFollowup = yield* decodeThreadSendResult(
            runningFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: followupStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const queuedFollowupCall = yield* invoke("t3_thread_send", {
            threadId: delegated.childThreadId,
            message: queuedFollowupPrompt,
            mode: "queue",
            clientRequestId: "delegated-child-replay-queued-1",
          });
          const queuedFollowup = yield* decodeThreadSendResult(
            queuedFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(queuedFollowup).toMatchObject({
            status: "queued",
            delivery: "queued",
          });

          const pendingProjection = yield* orchestrator.getThreadProjection(
            delegated.childThreadId,
          );
          const followupTasks = (yield* orchestrator.getThreadProjection(
            parentThreadId,
          )).subagents.filter(
            (task) =>
              task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
          );
          expect(followupTasks).toHaveLength(2);
          expect(followupTasks.every((task) => task.result === null)).toBe(true);
          expect(followupTasks.map((task) => task.id)).toEqual([
            runningFollowup.taskId,
            queuedFollowup.taskId,
          ]);
          expect(
            pendingProjection.runs.find((run) => run.id === delegated.childRunId)?.status,
          ).toBe("completed");
          expect(
            pendingProjection.runs.find((run) => run.id === runningFollowup.runId)?.status,
          ).toBe("running");
          expect(
            pendingProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status,
          ).toBe("queued");
          expect(
            (yield* orchestrator.getThreadProjection(parentThreadId)).runs.some(
              (run) => run.status === "running",
            ),
          ).toBe(true);

          const pendingStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const pendingStatus = yield* decodeDelegateTaskResult(
            pendingStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(pendingStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: true,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });

          const finalSequence = yield* orchestrator.getThreadEventSequence(delegated.childThreadId);
          const interruptCall = yield* invoke("t3_thread_interrupt", {
            threadId: delegated.childThreadId,
            runId: runningFollowup.runId,
            reason: "Allow the queued replay follow-up to run.",
            clientRequestId: "interrupt-delegated-child-replay-1",
          });
          const interrupt = yield* decodeThreadInterruptResult(
            interruptCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(interrupt).toMatchObject({
            runId: runningFollowup.runId,
            status: "interrupt_requested",
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === queuedFollowup.runId &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Queued follow-up did not complete."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const finalProjection = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(finalProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
            "interrupted",
          );
          expect(finalProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status).toBe(
            "completed",
          );
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === followupTasks[1]!.id &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up task did not settle."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const finishedParent = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[0]!.id)?.status,
          ).toBe("interrupted");
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id),
          ).toMatchObject({
            status: "completed",
            result,
          });
          expect(
            finishedParent.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === delegated.childThreadId,
            ),
          ).toHaveLength(3);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id)
              ?.completionDelivery?.state,
          ).toBe("claimed");
          const finalStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const finalStatus = yield* decodeDelegateTaskResult(
            finalStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(finalStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: false,
            latestTerminalRunId: queuedFollowup.runId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: latestSummary,
          });
          const followupTransfer = finishedParent.contextTransfers.find(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourcePoint.runId === queuedFollowup.runId,
          );
          expect(followupTransfer).toBeDefined();
          expect(finalStatus.latestTerminalResultContextTransferId).toBe(followupTransfer?.id);
          expect(finalStatus.latestTerminalResultContextTransferId).not.toBe(
            delegated.resultContextTransferId,
          );
          const read = yield* invoke("t3_thread_read", {
            threadId: delegated.childThreadId,
            limit: 100,
          });
          expect(read.isError).not.toBe(true);
          const afterRead = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            afterRead.subagents.find((task) => task.id === queuedFollowup.taskId)
              ?.completionDelivery?.state,
          ).toBe("acknowledged");
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );
});

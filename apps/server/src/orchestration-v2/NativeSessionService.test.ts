import * as SqlClient from "effect/sql/SqlClient";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  RunId,
  ProviderTurnId,
  TurnItemId,
  NativeSessionAdoptInput,
  NativeSessionError,
  NativeSessionReleaseInput,
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  ProviderDriverKind,
  ProviderThreadId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type NativeSessionObservation,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as CodexProtocol from "effect-codex-app-server/protocol";
import type * as CodexError from "effect-codex-app-server/errors";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import {
  makeNativeWritePolicy,
  NativeSessionWriteContext,
  releaseNativeSession,
} from "./NativeSessionProtocol.ts";
import { applyOrchestrationV2ProjectionEvent } from "../../../../packages/client-runtime/src/state/orchestrationV2Projection.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as NativeSessionService from "./NativeSessionService.ts";
import * as NativeSessionStore from "./NativeSessionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { planThreadDeletion } from "./ThreadDeletion.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

const threadId = ThreadId.make("app-native");
const projectId = ProjectId.make("project-native");
const environmentId = EnvironmentId.make("environment-native");
const providerInstanceId = ProviderInstanceId.make("codex");
const opId = "019bd450-188a-7000-8000-000000000002";
const nativeId = "019bd450-188a-7000-8000-000000000001";
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const boot = (yield* fs.readFileString("/proc/sys/kernel/random/boot_id")).trim();
  const now = yield* DateTime.now;
  const adopt = yield* Schema.decodeUnknownEffect(NativeSessionAdoptInput)({
    contractVersion: 1,
    environmentId,
    projectId,
    threadId,
    operationId: opId,
    commandId: "adopt-command",
    expectedEpoch: 0,
    providerInstanceId,
    sourceStopped: {
      evidenceId: "source-exit-proof",
      process: { pid: 2147483647, start: "10", boot },
    },
    settings: {
      model: "gpt-5.4",
      reasoningEffort: "high",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
    binding: {
      home: "/private/codex",
      cwd: "/work",
      nativeId,
      protocolVersion: "0.164.0",
      nativeStores: {
        sessionStore: "/private/codex/sessions",
        sessionStoreIdentity: "1:2:0",
        writerLockStore: "/private/codex/thread-writer-locks",
        writerLockStoreIdentity: "1:3:0",
      },
      transport: {
        kind: "shared-daemon",
        proof: {
          process: { pid: 100, start: "10", boot },
          executable: "/bin/codex",
          codexIdentity: "1:4:0",
          socket: "/private/socket",
          socketIdentity: "1:5:0",
          controlIdentity: "1:6:0",
          rendezvous: "/private/link",
          rendezvousIdentity: "1:7:0",
          uid: 1000,
        },
      },
    },
  });
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  const thread = OrchestrationV2AppThread.make({
    id: threadId,
    projectId,
    title: "Native session",
    providerInstanceId,
    modelSelection: {
      instanceId: providerInstanceId,
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/work",
    activeProviderThreadId: ProviderThreadId.make("native-provider-thread"),
    createdBy: "user",
    creationSource: "web",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    lastVisitedAt: null,
    deletedAt: null,
  });
  yield* projection.apply({
    id: EventId.make("seed:thread"),
    threadId,
    occurredAt: now,
    type: "thread.created",
    payload: thread,
  });
  yield* projection.apply({
    id: EventId.make("seed:provider"),
    threadId,
    occurredAt: now,
    type: "provider-thread.updated",
    payload: {
      id: ProviderThreadId.make("native-provider-thread"),
      appThreadId: threadId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId,
      providerSessionId: null,
      ownerNodeId: null,
      nativeThreadRef: { driver: ProviderDriverKind.make("codex"), nativeId, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "not_loaded",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      contextUsage: null,
      nativeMetadata: null,
      goal: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return adopt;
});
const sinkLayer = EventSink.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, EventStore.layer)),
);
const storeLayer = NativeSessionStore.layer.pipe(Layer.provide(sinkLayer));
const base = Layer.mergeAll(
  storeLayer,
  sinkLayer,
  ProjectionStore.layer,
  EventStore.layer,
  IdAllocator.layer,
).pipe(Layer.provideMerge(Sqlite.layerMemory), Layer.provideMerge(NodeServices.layer));
const observation: NativeSessionObservation = {
  complete: true,
  digest: "snapshot-one",
  blockers: [],
  turns: [
    {
      id: "native-turn-one",
      status: "completed",
      items: [
        {
          id: "user-one",
          type: "userMessage",
          payload: {
            id: "user-one",
            type: "userMessage",
            content: [{ type: "text", text: "Existing native question" }],
          },
        },
        {
          id: "assistant-one",
          type: "agentMessage",
          payload: { id: "assistant-one", type: "agentMessage", text: "Existing native answer" },
        },
      ],
    },
  ],
};
const testLayer = (
  calls: string[],
  options: {
    failRelease?: boolean;
    beforeOpen?: () => Effect.Effect<void>;
    missingRuntime?: () => boolean;
    nativeRelease?: () => Effect.Effect<
      { readonly status: "unsubscribed" },
      NativeSessionError | CodexError.CodexAppServerError,
      NativeSessionStore.NativeSessionStore | NativeSessionWriteContext
    >;
    runtimePolicy?: Partial<ProviderAdapter.ProviderAdapterV2RuntimePolicy>;
    afterBegin?: (
      operation: import("@t3tools/contracts").NativeSessionOperation,
    ) => Effect.Effect<void>;
    beforeWrite?: (
      entries: ReadonlyArray<import("@t3tools/contracts").NativeSessionJournalEntry>,
    ) => Effect.Effect<void, NativeSessionError>;
    mcpVerified?: boolean;
    observation?: () => NativeSessionObservation;
  } = {},
) => {
  let attached = false;
  const runtime = {
    resumeThread: (input: { providerThread: object }) =>
      Effect.sync(() => {
        calls.push("resume");
        attached = true;
        return input.providerThread;
      }),
    nativeSession: {
      attached: () => attached,
      inspect: () =>
        Effect.succeed({
          history: options.observation?.() ?? observation,
          settingsVerified: true,
          mcpVerified: options.mcpVerified ?? true,
        }),
      release: () =>
        options.nativeRelease?.() ??
        Effect.sync(() => {
          calls.push("unsubscribe");
          return { status: "unsubscribed" as const };
        }),
    },
  } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
  return NativeSessionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            (options.beforeOpen?.() ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (options.missingRuntime?.()) calls.push("recovery-open");
                  return runtime;
                }),
              ),
            ),
          get: () =>
            Effect.succeed(
              attached && !options.missingRuntime?.() ? Option.some(runtime) : Option.none(),
            ),
          isLive: () => Effect.succeed(attached),
          release: (input) =>
            options.failRelease
              ? new ProviderSessionManager.ProviderSessionReleaseError({
                  providerSessionId: input.providerSessionId,
                  reason: "manual_shutdown",
                })
              : Effect.sync(() => {
                  calls.push("closed");
                  attached = false;
                }),
        }),
        Layer.succeed(Environment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        Layer.succeed(ServerConfig.ServerConfig, {
          dbPath: "/private/state.sqlite",
        } as ServerConfig.ServerConfig["Service"]),
        Layer.succeed(RuntimePolicy.RuntimePolicyV2, {
          resolve: ({ thread }) =>
            Effect.succeed({
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              cwd: "/work",
              ...options.runtimePolicy,
            }),
        }),
      ),
    ),
    Layer.provideMerge(
      options.afterBegin === undefined && options.beforeWrite === undefined
        ? base
        : Layer.effect(
            NativeSessionStore.NativeSessionStore,
            Effect.gen(function* () {
              const original = yield* NativeSessionStore.NativeSessionStore;
              return NativeSessionStore.NativeSessionStore.of({
                ...original,
                begin: (input) =>
                  original.begin(input).pipe(Effect.tap(options.afterBegin ?? (() => Effect.void))),
                write: (entries, events, threadCommit) =>
                  (options.beforeWrite?.(entries) ?? Effect.void).pipe(
                    Effect.andThen(original.write(entries, events, threadCommit)),
                  ),
              });
            }),
          ).pipe(Layer.provideMerge(base)),
    ),
  );
};

it.effect(
  "adopts eagerly without a prompt and projects native history without runnable historical runs",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      const first = yield* service.adopt(adopt);
      expect(first).toMatchObject({
        state: "ready",
        nativeId,
        controller: { type: "t3", epoch: 1 },
        history: { complete: true },
      });
      expect(yield* service.adopt(adopt)).toEqual(first);
      expect(calls).toEqual(["resume"]);
      const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
        threadId,
      );
      expect(projection.runs).toEqual([]);
      expect(projection.messages.map((message) => message.text)).toEqual([
        "Existing native question",
        "Existing native answer",
      ]);
      expect(projection.turnItems).toHaveLength(2);
    }).pipe(Effect.provide(testLayer(calls)));
  },
);
it.effect("does not call an attach with unverified MCP configuration ready", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const result = yield* (yield* NativeSessionService.NativeSessionService).adopt(yield* fixture);
    expect(result.state).toBe("blocked");
    expect(result.controller?.type).toBe("adopting");
    expect(result.blockers.map((value) => value.code)).toContain("mcp-configuration-unverified");
  }).pipe(Effect.provide(testLayer(calls, { mcpVerified: false })));
});
it.effect(
  "revokes before release and returns a reserved launch receipt only after native unsubscribe and connection settlement",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      yield* service.adopt(adopt);
      const release = yield* Schema.decodeUnknownEffect(NativeSessionReleaseInput)({
        contractVersion: 1,
        environmentId,
        projectId,
        threadId,
        operationId: "019bd450-188a-7000-8000-000000000003",
        commandId: "release-command",
        expectedEpoch: 1,
        destination: {
          workspaceId: "workspace",
          terminalId: "terminal",
          process: adopt.sourceStopped.process,
        },
        launchActionId: "019bd450-188a-7000-8000-000000000004",
      });
      const result = yield* service.release(release);
      expect(calls).toEqual(["resume", "unsubscribe", "closed"]);
      expect(result).toMatchObject({
        state: "ready",
        controller: { type: "external", epoch: 2 },
        releaseReceipt: {
          operationId: release.operationId,
          launchActionId: release.launchActionId,
          destination: release.destination,
        },
      });
      expect(yield* service.release(release)).toEqual(result);
      expect(calls).toHaveLength(3);
    }).pipe(Effect.provide(testLayer(calls)));
  },
);
it.effect("never reports a detached projection as native release completion", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const adopt = yield* fixture;
    const service = yield* NativeSessionService.NativeSessionService;
    yield* service.adopt(adopt);
    const result = yield* service.release({
      ...adopt,
      operationId: "019bd450-188a-7000-8000-000000000003",
      commandId: CommandId.make("release"),
      expectedEpoch: 1,
      destination: {
        workspaceId: "workspace",
        terminalId: "terminal",
        process: adopt.sourceStopped.process,
      },
      launchActionId: "019bd450-188a-7000-8000-000000000004",
    });
    expect(result.state).toBe("blocked");
    expect(result.controller?.type).toBe("releasing");
    expect(result.releaseReceipt).toBe(null);
  }).pipe(Effect.provide(testLayer(calls, { failRelease: true })));
});

it.effect("keeps an unresolved destination launch reservation closed to competing adoption", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const adopt = yield* fixture;
    const service = yield* NativeSessionService.NativeSessionService;
    yield* service.adopt(adopt);
    const released = yield* service.release({
      contractVersion: 1,
      environmentId,
      projectId,
      threadId,
      operationId: "019bd450-188a-7000-8000-000000000003",
      commandId: CommandId.make("release-reservation"),
      expectedEpoch: 1,
      destination: {
        workspaceId: "workspace",
        terminalId: "terminal",
        process: adopt.sourceStopped.process,
      },
      launchActionId: "019bd450-188a-7000-8000-000000000004",
    });
    const result = yield* service.adopt({
      ...adopt,
      expectedEpoch: 2,
      operationId: "019bd450-188a-7000-8000-000000000005",
      commandId: CommandId.make("competing-adopt"),
    });
    expect(result.state).toBe("blocked");
    expect(result.controller?.type).toBe("external");
    expect(result.releaseReceipt).toEqual(released.releaseReceipt);
    expect(result.blockers.map((value) => value.code)).toContain("launch-reservation-unresolved");
    expect(calls).toEqual(["resume", "unsubscribe", "closed"]);
  }).pipe(Effect.provide(testLayer(calls)));
});
it.effect(
  "does not admit scheduled or direct thread sends after release revokes the controller",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      yield* service.adopt(adopt);
      yield* service.release({
        contractVersion: 1,
        environmentId,
        projectId,
        threadId,
        operationId: "019bd450-188a-7000-8000-000000000003",
        commandId: CommandId.make("release-gate"),
        expectedEpoch: 1,
        destination: {
          workspaceId: "workspace",
          terminalId: "terminal",
          process: adopt.sourceStopped.process,
        },
        launchActionId: "019bd450-188a-7000-8000-000000000004",
      });
      expect(
        (yield* Effect.flip(
          service.authorizeCommand({ type: "message.dispatch", threadId } as never),
        )).code,
      ).toBe("controller-unavailable");
    }).pipe(Effect.provide(testLayer(calls)));
  },
);

it.effect.each([false, true])("refreshes T3-origin input, empty %s", (emptyFirst) => {
  const calls: string[] = [];
  let observed = observation;
  return Effect.gen(function* () {
    const adopt = yield* fixture;
    const service = yield* NativeSessionService.NativeSessionService;
    yield* service.adopt(adopt);
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const nodeId = NodeId.make("app-node");
    const runId = RunId.make("app-run");
    const messageId = MessageId.make("app-message");
    const providerTurnId = ProviderTurnId.make("app-provider-turn");
    yield* projection.apply({
      id: EventId.make("app:message"),
      threadId,
      occurredAt: now,
      type: "message.updated",
      payload: {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "New T3 input",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* projection.apply({
      id: EventId.make("app:item"),
      threadId,
      occurredAt: now,
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make("app-user-item"),
        threadId,
        runId,
        nodeId,
        providerThreadId: ProviderThreadId.make("native-provider-thread"),
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1000001,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        inputIntent: "turn_start",
        messageId,
        text: "New T3 input",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    });
    yield* projection.apply({
      id: EventId.make("app:turn"),
      threadId,
      occurredAt: now,
      type: "provider-turn.updated",
      payload: {
        id: providerTurnId,
        providerThreadId: ProviderThreadId.make("native-provider-thread"),
        nodeId,
        runAttemptId: null,
        nativeTurnRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "native-new-turn",
          strength: "strong",
        },
        ordinal: 1,
        status: "completed",
        startedAt: now,
        completedAt: now,
      },
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal) VALUES (${threadId}, ${"app-user-item"}, ${1000001})`;
    observed = {
      ...observation,
      digest: "snapshot-two",
      turns: [
        ...observation.turns,
        {
          id: "native-new-turn",
          status: "completed",
          items: [
            {
              id: "native-new-user",
              type: "userMessage",
              payload: {
                id: "native-new-user",
                type: "userMessage",
                content: [{ type: "text", text: "New T3 input" }],
              },
            },
          ],
        },
        {
          id: "external-later-turn",
          status: "completed",
          items: [
            {
              id: "external-later-answer",
              type: "agentMessage",
              payload: {
                id: "external-later-answer",
                type: "agentMessage",
                text: "External later answer",
              },
            },
          ],
        },
      ],
    };
    yield* service.refresh({
      contractVersion: 1,
      environmentId,
      projectId,
      threadId,
      operationId: "019bd450-188a-7000-8000-000000000006",
      commandId: CommandId.make("refresh-new-input"),
    });
    const current = yield* projection.getThreadProjection(threadId);
    expect(
      current.messages
        .filter((message) => message.text === "New T3 input")
        .map((message) => message.id),
    ).toEqual([messageId]);
    expect(current.turnItems.filter((item) => item.type === "user_message")).toHaveLength(2);
    expect(
      current.turnItems
        .toSorted((left, right) => left.ordinal - right.ordinal)
        .slice(-2)
        .map((item) =>
          item.type === "user_message" || item.type === "assistant_message" ? item.text : item.type,
        ),
    ).toEqual(["New T3 input", "External later answer"]);

    const sink = yield* EventSink.EventSinkV2;
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection: current.thread.modelSelection,
      providerThreadId: ProviderThreadId.make("native-provider-thread"),
      userMessageId: messageId,
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    };
    const unsentMessage = {
      ...current.messages.find((m) => m.id === messageId)!,
      id: MessageId.make("unsent-message"),
      text: "App-only failed input",
      creationSource: "web" as const,
    };
    const appUserItem = current.turnItems.find((i) => i.id === TurnItemId.make("app-user-item"));
    if (appUserItem?.type !== "user_message")
      return yield* Effect.die(new Error("Mapped app input is missing"));
    const unsentItem = {
      ...appUserItem,
      id: TurnItemId.make("unsent-item"),
      type: "user_message" as const,
      inputIntent: "turn_start" as const,
      messageId: unsentMessage.id,
      text: unsentMessage.text,
      attachments: [],
      createdBy: "user" as const,
      creationSource: "web" as const,
      nativeItemRef: null,
      providerTurnId: null,
      ordinal: 1000003,
      status: "failed" as const,
    };
    const unindexedMessage = {
      ...unsentMessage,
      id: MessageId.make("unindexed-native-message"),
      text: "Live native reply",
    };
    const unindexedItem = {
      ...unsentItem,
      id: TurnItemId.make("unindexed-native-item"),
      messageId: unindexedMessage.id,
      text: unindexedMessage.text,
      providerTurnId,
      ordinal: 1000004,
      nativeItemRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "live-unindexed",
        strength: "strong" as const,
      },
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make("audit-run"),
          threadId,
          occurredAt: now,
          type: "run.created",
          payload: run,
        },
        {
          id: EventId.make("unsent-message"),
          threadId,
          occurredAt: now,
          type: "message.updated",
          payload: unsentMessage,
        },
        {
          id: EventId.make("unsent-item"),
          threadId,
          occurredAt: now,
          type: "turn-item.updated",
          payload: unsentItem,
        },
        {
          id: EventId.make("unindexed-message"),
          threadId,
          occurredAt: now,
          type: "message.updated",
          payload: unindexedMessage,
        },
        {
          id: EventId.make("unindexed-item"),
          threadId,
          occurredAt: now,
          type: "turn-item.updated",
          payload: unindexedItem,
        },
      ],
    });
    const events = yield* EventStore.EventStoreV2;
    let client = yield* projection.getThreadProjection(threadId);
    let replay = client;
    const audit = { runs: client.runs, providerTurns: client.providerTurns };
    for (const [step, snapshot] of [
      emptyFirst ? { ...observation, turns: [] } : observation,
      emptyFirst ? { ...observation, turns: [] } : observation,
      { ...observation, turns: [] },
      { ...observation, turns: [] },
    ].entries()) {
      observed = { ...snapshot, digest: `rollback-${step}` };
      const sequence = yield* events.latestSequence({ threadId });
      expect(
        (yield* service.refresh({
          ...adopt,
          operationId: `019bd450-188a-7000-8000-00000000006${step}`,
          commandId: CommandId.make(`origin-rollback-${step}`),
        })).state,
      ).toBe("ready");
      for (const stored of yield* events
        .read({ threadId, afterSequence: sequence })
        .pipe(Stream.runCollect)) {
        client = applyOrchestrationV2ProjectionEvent(client, stored.event)!;
        replay = ProjectionStore.applyToProjection(replay, stored.event);
      }
      const persisted = yield* projection.getThreadProjection(threadId);
      for (const state of [persisted, client, replay]) {
        expect(state.messages.map((m) => m.text).sort()).toEqual(
          step < 2 && !emptyFirst
            ? ["App-only failed input", "Existing native answer", "Existing native question"]
            : ["App-only failed input"],
        );
        expect(state.turnItems.map((i) => i.id).sort()).toEqual(
          persisted.turnItems.map((i) => i.id).sort(),
        );
        expect(state.turnItems.some((i) => i.id === TurnItemId.make("app-user-item"))).toBe(false);
        expect(state.turnItems.some((i) => i.id === unsentItem.id)).toBe(true);
        expect(state.visibleTurnItems.some((i) => i.sourceItemId === appUserItem.id)).toBe(false);
        expect(state.visibleTurnItems.map((i) => i.sourceItemId).sort()).toEqual(
          persisted.visibleTurnItems.map((i) => i.sourceItemId).sort(),
        );
        expect(state.runs).toEqual(audit.runs);
        expect(state.providerTurns).toEqual(audit.providerTurns);
      }
    }
    expect(calls).toEqual(["resume"]);
  }).pipe(Effect.provide(testLayer(calls, { observation: () => observed })));
});

it.effect(
  "releases a definitively acknowledged MCP-blocked adoption through the normal native drain",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      const failed = yield* service.adopt(adopt);
      expect(failed.controller?.type).toBe("adopting");
      const result = yield* service.release({
        contractVersion: 1,
        environmentId,
        projectId,
        threadId,
        operationId: "019bd450-188a-7000-8000-000000000007",
        commandId: CommandId.make("abort-known-adoption"),
        expectedEpoch: 1,
        destination: {
          workspaceId: "workspace",
          terminalId: "terminal",
          process: adopt.sourceStopped.process,
        },
        launchActionId: "019bd450-188a-7000-8000-000000000008",
      });
      expect(result).toMatchObject({ state: "ready", controller: { type: "external", epoch: 2 } });
      expect(result.releaseReceipt?.launchActionId).toBe("019bd450-188a-7000-8000-000000000008");
      expect(calls).toEqual(["resume", "unsubscribe", "closed"]);
    }).pipe(Effect.provide(testLayer(calls, { mcpVerified: false })));
  },
);

it.effect("keeps an unknown native send pending when aborting a blocked adoption", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const adopt = yield* fixture;
    const service = yield* NativeSessionService.NativeSessionService;
    yield* service.adopt(adopt);
    const store = yield* NativeSessionStore.NativeSessionStore;
    yield* store.write([
      {
        type: "effect",
        value: {
          id: "uncertain-resume",
          threadId,
          operationId: adopt.operationId,
          epoch: 1,
          connectionId: "connection",
          method: "thread/resume",
          paramsHash: "hash",
          state: "uncertain",
        },
      },
    ]);
    const result = yield* service.release({
      contractVersion: 1,
      environmentId,
      projectId,
      threadId,
      operationId: "019bd450-188a-7000-8000-000000000007",
      commandId: CommandId.make("abort-unknown-adoption"),
      expectedEpoch: 1,
      destination: {
        workspaceId: "workspace",
        terminalId: "terminal",
        process: adopt.sourceStopped.process,
      },
      launchActionId: "019bd450-188a-7000-8000-000000000008",
    });
    expect(result.state).toBe("blocked");
    expect(result.releaseReceipt).toBe(null);
    expect(result.unresolvedEffectIds).toEqual(["uncertain-resume"]);
    expect(calls).toEqual(["resume"]);
  }).pipe(Effect.provide(testLayer(calls, { mcpVerified: false })));
});

it.effect(
  "reconciles the displayed reasoning selection atomically before adoption is ready",
  () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      const result = yield* service.adopt({
        ...adopt,
        settings: { ...adopt.settings, reasoningEffort: "ultra" },
      });
      expect(result.state).toBe("ready");
      const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
        threadId,
      );
      expect(projection.thread.modelSelection.options).toEqual([
        { id: "reasoningEffort", value: "ultra" },
      ]);
    }).pipe(Effect.provide(testLayer(calls)));
  },
);

it.effect(
  "reconciles mutable native order and empty truncation identically for SQL, replay and connected clients",
  () => {
    let observed = observation;
    return Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      yield* service.adopt(adopt);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const initial = yield* projections.getThreadProjection(threadId);
      const appMessage = {
        ...initial.messages[0]!,
        id: MessageId.make("app-only-message"),
        text: "App-only note",
        creationSource: "web" as const,
      };
      const appItem = {
        ...initial.turnItems[0]!,
        id: TurnItemId.make("app-only-item"),
        messageId: appMessage.id,
        text: appMessage.text,
        nativeItemRef: null,
        creationSource: "web" as const,
      };
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("note-message"),
        threadId,
        occurredAt: now,
        type: "message.updated",
        payload: appMessage,
      });
      yield* projections.apply({
        id: EventId.make("note-item"),
        threadId,
        occurredAt: now,
        type: "turn-item.updated",
        payload: appItem,
      });
      let client = yield* projections.getThreadProjection(threadId);
      let replay = client;
      const modified = {
        ...observation.turns[0]!.items[1]!,
        payload: { id: "assistant-one", type: "agentMessage", text: "Edited native answer" },
      };
      observed = {
        ...observation,
        digest: "reordered",
        turns: [{ ...observation.turns[0]!, items: [modified, observation.turns[0]!.items[0]!] }],
      };
      for (const [index, state] of [
        observed,
        { ...observation, digest: "empty", turns: [] },
      ].entries()) {
        observed = state;
        const sequence = yield* events.latestSequence({ threadId });
        const refreshed = yield* service.refresh({
          ...adopt,
          operationId: `019bd450-188a-7000-8000-00000000001${index}`,
          commandId: CommandId.make(`reconcile-${index}`),
        });
        expect(refreshed).toMatchObject({ state: "ready", blockers: [] });
        const delta = yield* events
          .read({ threadId, afterSequence: sequence })
          .pipe(Stream.runCollect);
        for (const stored of delta) {
          client = applyOrchestrationV2ProjectionEvent(client, stored.event)!;
          replay = ProjectionStore.applyToProjection(replay, stored.event);
        }
        const sql = yield* projections.getThreadProjection(threadId);
        for (const projected of [sql, client, replay]) {
          expect(projected.messages.map((message) => message.text).sort()).toEqual(
            index === 0
              ? ["App-only note", "Edited native answer", "Existing native question"]
              : ["App-only note"],
          );
          const nativeItems = projected.turnItems
            .filter((item) => item.nativeItemRef !== null)
            .toSorted((a, b) => a.ordinal - b.ordinal);
          expect(nativeItems.map((item) => item.nativeItemRef!.nativeId)).toEqual(
            index === 0 ? ["assistant-one", "user-one"] : [],
          );
          expect(projected.turnItems.some((item) => item.id === appItem.id)).toBe(true);
        }
      }
    }).pipe(Effect.provide(testLayer([], { observation: () => observed })));
  },
);

it.effect("opens a fenced release runtime when persisted t3 control survives a restart", () => {
  const calls: string[] = [];
  let missing = false;
  return Effect.gen(function* () {
    const adopt = yield* fixture;
    const service = yield* NativeSessionService.NativeSessionService;
    yield* service.adopt(adopt);
    missing = true;
    expect((yield* service.adopt(adopt)).state).toBe("blocked");
    const release = {
      ...adopt,
      operationId: "019bd450-188a-7000-8000-000000000020",
      commandId: CommandId.make("restart-release"),
      expectedEpoch: 1,
      destination: { workspaceId: "w", terminalId: "t", process: adopt.sourceStopped.process },
      launchActionId: "019bd450-188a-7000-8000-000000000021",
    };
    const first = yield* service.release(release);
    expect(first).toMatchObject({ state: "ready", controller: { type: "external", epoch: 2 } });
    expect(first.releaseReceipt?.launchActionId).toBe(release.launchActionId);
    expect(yield* service.release(release)).toEqual(first);
    expect(calls).toEqual(["resume", "recovery-open", "unsubscribe", "closed"]);
  }).pipe(Effect.provide(testLayer(calls, { missingRuntime: () => missing })));
});

it.effect.each([
  [
    "approval policy",
    "approval-required",
    { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } },
  ],
  [
    "writable workspace",
    "approval-required",
    { approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite" } },
  ],
  [
    "read-only network",
    "approval-required",
    { approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly", networkAccess: true } },
  ],
  [
    "outside roots",
    "auto-accept-edits",
    {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/"] },
    },
  ],
  [
    "workspace network",
    "auto",
    {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", networkAccess: true },
    },
  ],
] as const)(
  "rejects native %s above destination permissions before enrollment",
  ([_label, mode, settings]) => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const adopt = yield* fixture;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const prior = yield* projections.getThreadProjection(threadId);
      yield* projections.apply({
        id: EventId.make("lower-mode"),
        threadId,
        occurredAt: yield* DateTime.now,
        type: "thread.runtime-mode-updated",
        payload: { ...prior.thread, runtimeMode: mode },
      });
      const result = yield* Effect.result(
        (yield* NativeSessionService.NativeSessionService).adopt({
          ...adopt,
          settings: { ...adopt.settings, ...settings },
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "native-permissions-unrepresentable" },
      });
      expect(
        Option.isNone(yield* (yield* NativeSessionStore.NativeSessionStore).get(threadId)),
      ).toBe(true);
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(testLayer(calls)));
  },
);
it.effect("rechecks the caller ceiling inside native adoption before enrollment", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const adopt = yield* fixture;
    expect(
      yield* Effect.result(
        (yield* NativeSessionService.NativeSessionService).adopt(adopt).pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "approval-required",
            interactionMode: "default",
          }),
        ),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "native-permissions-unrepresentable" } });
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(testLayer(calls)));
});
it.effect("honors explicit resolved permission overrides before native enrollment", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const adopt = yield* fixture;
    expect(
      yield* Effect.result((yield* NativeSessionService.NativeSessionService).adopt(adopt)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "native-permissions-unrepresentable" } });
    expect(calls).toEqual([]);
  }).pipe(
    Effect.provide(
      testLayer(calls, {
        runtimePolicy: { approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" } },
      }),
    ),
  );
});

it.effect("single-flights overlapping release retries and preserves the completed receipt", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const secondAccepted = yield* Deferred.make<void>();
    let acceptedReleases = 0;
    let releasePolicy: Effect.Success<ReturnType<typeof makeNativeWritePolicy>>;
    let releases = 0;
    yield* Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      yield* service.adopt(adopt);
      releasePolicy = yield* makeNativeWritePolicy({
        threadId,
        epoch: 1,
        operationId: adopt.operationId,
        connectionId: "release-connection",
        nativeId,
        cwd: "/work",
        settings: adopt.settings,
      });
      const release = {
        ...adopt,
        operationId: "019bd450-188a-7000-8000-000000000022",
        commandId: CommandId.make("concurrent-release"),
        expectedEpoch: 1,
        destination: { workspaceId: "w", terminalId: "t", process: adopt.sourceStopped.process },
        launchActionId: "019bd450-188a-7000-8000-000000000023",
      };
      const first = yield* service.release(release).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const second = yield* service.release(release).pipe(Effect.forkScoped);
      yield* Deferred.await(secondAccepted);
      yield* Deferred.succeed(finish, undefined);
      const firstResult = yield* Fiber.join(first);
      const secondResult = yield* Fiber.join(second);
      expect(firstResult.state).toBe("ready");
      expect(secondResult).toEqual(firstResult);
      expect(yield* service.release(release)).toEqual(firstResult);
      expect(releases).toBe(1);
    }).pipe(
      Effect.provide(
        testLayer([], {
          afterBegin: (operation) =>
            operation.kind === "release"
              ? Effect.gen(function* () {
                  acceptedReleases++;
                  if (acceptedReleases === 2) yield* Deferred.succeed(secondAccepted, undefined);
                })
              : Effect.void,
          nativeRelease: () =>
            Effect.gen(function* () {
              releases++;
              const context = yield* NativeSessionWriteContext;
              yield* releasePolicy
                .beforeWrite({
                  id: releases,
                  method: "thread/unsubscribe",
                  params: { threadId: nativeId },
                })
                .pipe(
                  Effect.provideService(NativeSessionWriteContext, {
                    ...context,
                    id: `${context.id}:before-mcp-disable`,
                  }),
                );
              yield* releasePolicy.onResponse!({
                id: releases,
                result: { status: "unsubscribed" },
              });
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(finish);
              return { status: "unsubscribed" as const };
            }),
        }),
      ),
    );
  }),
);

it.effect.each([1, 2, 3])(
  "recovers release after acknowledged lifecycle step %s without repeating it",
  (crashAfter) => {
    const sent: string[] = [];
    let missing = false;
    let crashed = false;
    let requestId = 0;
    let releaseDriver: () => Effect.Effect<
      { status: "unsubscribed" },
      NativeSessionError | CodexError.CodexAppServerError,
      NativeSessionStore.NativeSessionStore
    >;
    return Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      yield* service.adopt(adopt);
      const store = yield* NativeSessionStore.NativeSessionStore;
      const native = Option.getOrThrow(yield* store.get(threadId));
      const policy = yield* makeNativeWritePolicy({
        threadId,
        epoch: 1,
        operationId: adopt.operationId,
        connectionId: "old-connection",
        nativeId,
        cwd: "/work",
        settings: adopt.settings,
        mcpServerName: native.mcpServerName,
      });
      releaseDriver = () =>
        releaseNativeSession({
          native,
          disableMcpConfig: { [`mcp_servers.${native.mcpServerName}`]: { enabled: false } },
          request: (method, params) =>
            Effect.gen(function* () {
              const id = ++requestId;
              yield* policy.beforeWrite({ id, method, params });
              if (method !== "mcpServerStatus/list") sent.push(method);
              const result =
                method === "thread/resume"
                  ? {
                      thread: { id: nativeId, cwd: "/work" },
                      cwd: "/work",
                      model: adopt.settings.model,
                      reasoningEffort: adopt.settings.reasoningEffort,
                      approvalPolicy: adopt.settings.approvalPolicy,
                      approvalsReviewer: "user",
                      sandbox: adopt.settings.sandboxPolicy,
                    }
                  : method === "mcpServerStatus/list"
                    ? {
                        data: [{ name: native.mcpServerName, runtimeStatus: "disabled" }],
                        nextCursor: null,
                      }
                    : { status: "unsubscribed" };
              yield* policy.onResponse!({ id, result });
              if (!crashed && sent.length === crashAfter && method !== "mcpServerStatus/list") {
                crashed = true;
                return yield* new NativeSessionError({
                  code: "native-connection-unsettled",
                  threadId,
                });
              }
              return result;
            }),
        }).pipe(Effect.as({ status: "unsubscribed" as const }));
      const release = {
        ...adopt,
        operationId: "019bd450-188a-7000-8000-000000000024",
        commandId: CommandId.make("crash-release"),
        expectedEpoch: 1,
        destination: { workspaceId: "w", terminalId: "t", process: adopt.sourceStopped.process },
        launchActionId: "019bd450-188a-7000-8000-000000000025",
      };
      const failed = yield* service.release(release);
      expect(failed.state).toBe("blocked");
      expect(failed.releaseReceipt).toBeNull();
      missing = true;
      const recovered = yield* service.release(release);
      expect(recovered).toMatchObject({
        state: "ready",
        controller: { type: "external", epoch: 2 },
      });
      expect(sent).toEqual(["thread/unsubscribe", "thread/resume", "thread/unsubscribe"]);
      expect(yield* service.release(release)).toEqual(recovered);
      expect((yield* store.effects(threadId)).map((effect) => effect.lifecycleResult)).toEqual([
        "unsubscribed",
        "resumed",
        "unsubscribed",
      ]);
    }).pipe(
      Effect.provide(
        testLayer([], { missingRuntime: () => missing, nativeRelease: () => releaseDriver() }),
      ),
    );
  },
);

it.effect(
  "includes durable native lifetimes in startup recovery even for an idle adopted thread",
  () =>
    Effect.gen(function* () {
      const adopt = yield* fixture;
      yield* (yield* NativeSessionService.NativeSessionService).adopt(adopt);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      expect(yield* projections.getRecoveryThreadIds("runtime")).toContain(threadId);
      const recovery = yield* projections.getRuntimeRecoveryProjection(threadId);
      expect(recovery.nativeSessions?.map((session) => session.binding.nativeId)).toEqual([
        nativeId,
      ]);
    }).pipe(Effect.provide(testLayer([]))),
);

const queuedAdmission = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
    threadId,
  );
  const run = {
    id: RunId.make("raced-run"),
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection: projection.thread.modelSelection,
    providerThreadId: ProviderThreadId.make("native-provider-thread"),
    userMessageId: MessageId.make("raced-message"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "queued" as const,
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  return yield* (yield* EventSink.EventSinkV2).commitCommand({
    commandId: CommandId.make("raced-admission"),
    threadId,
    commandType: "message.dispatch",
    acceptedAt: now,
    events: [
      {
        id: EventId.make("raced-run-event"),
        threadId,
        occurredAt: now,
        type: "run.created",
        payload: run,
      },
    ],
    effects: [],
  });
});
it.effect(
  "rejects previously authorized app admission at the actual commit boundary after native release",
  () =>
    Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      yield* service.adopt(adopt);
      yield* service.authorizeCommand({ type: "message.dispatch", threadId } as never);
      const released = yield* service.release({
        ...adopt,
        operationId: "019bd450-188a-7000-8000-000000000030",
        commandId: CommandId.make("release-before-commit"),
        expectedEpoch: 1,
        destination: { workspaceId: "w", terminalId: "t", process: adopt.sourceStopped.process },
        launchActionId: "019bd450-188a-7000-8000-000000000031",
      });
      expect(released.state).toBe("ready");
      const committed = yield* queuedAdmission;
      expect(committed.receipt.status).toBe("rejected");
      expect(
        (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(threadId)).runs,
      ).toEqual([]);
    }).pipe(Effect.provide(testLayer([]))),
);
it.effect("sees an admitted queue in a fresh snapshot after native revocation commits", () =>
  Effect.gen(function* () {
    const revoking = yield* Deferred.make<void>();
    const allowRevoke = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      yield* service.adopt(adopt);
      yield* service.authorizeCommand({ type: "message.dispatch", threadId } as never);
      const releasing = yield* service
        .release({
          ...adopt,
          operationId: "019bd450-188a-7000-8000-000000000032",
          commandId: CommandId.make("release-raced-commit"),
          expectedEpoch: 1,
          destination: { workspaceId: "w", terminalId: "t", process: adopt.sourceStopped.process },
          launchActionId: "019bd450-188a-7000-8000-000000000033",
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(revoking);
      expect((yield* queuedAdmission).receipt.status).toBe("accepted");
      yield* Deferred.succeed(allowRevoke, undefined);
      const result = yield* Fiber.join(releasing);
      expect(result.state).toBe("blocked");
      expect(result.releaseReceipt).toBeNull();
      expect(result.blockers.map((blocker) => blocker.code)).toContain("queued-work");
    }).pipe(
      Effect.provide(
        testLayer([], {
          beforeWrite: (entries) =>
            entries.some(
              (entry) => entry.type === "session" && entry.value.controller.type === "releasing",
            )
              ? Deferred.succeed(revoking, undefined).pipe(
                  Effect.andThen(Deferred.await(allowRevoke)),
                )
              : Effect.void,
        }),
      ),
    );
  }),
);
it.effect(
  "routes only selected conversation notifications and drains the current releasing connection",
  () =>
    Effect.gen(function* () {
      const adopt = yield* fixture;
      yield* (yield* NativeSessionService.NativeSessionService).adopt(adopt);
      const store = yield* NativeSessionStore.NativeSessionStore;
      const initial = {
        ...Option.getOrThrow(yield* store.get(threadId)),
        connectionId: "connection-one",
      };
      yield* store.write([{ type: "session", value: initial }]);
      const policy = yield* makeNativeWritePolicy({
        threadId,
        epoch: 1,
        operationId: adopt.operationId,
        connectionId: "connection-one",
        nativeId,
        cwd: "/work",
        settings: adopt.settings,
      });
      const incoming = yield* Queue.unbounded<string>();
      const delivered = yield* Queue.unbounded<string>();
      const observed = yield* Queue.unbounded<void>();
      const protocol = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        messages: { incoming: Stream.fromQueue(incoming), write: () => Effect.void },
        writePolicy: {
          ...policy,
          onNotification: (notification) =>
            policy.onNotification!(notification).pipe(
              Effect.tap(() => Queue.offer(observed, undefined)),
            ),
        },
        onNotification: (notification) =>
          Queue.offer(delivered, (notification.params as { marker: string }).marker).pipe(
            Effect.asVoid,
          ),
      });
      const emit = (target: string, marker: string) =>
        Queue.offer(
          incoming,
          JSON.stringify({
            method: "item/agentMessage/delta",
            params: { threadId: target, turnId: "turn", itemId: "item", delta: marker, marker },
          }),
        ).pipe(Effect.andThen(Queue.take(observed)));
      yield* emit("other-conversation", "foreign");
      yield* emit(nativeId, "selected");
      yield* store.write([
        { type: "session", value: { ...initial, controller: { type: "releasing", epoch: 2 } } },
      ]);
      yield* emit(nativeId, "drain-completion");
      yield* store.write([
        { type: "session", value: { ...initial, controller: { type: "external", epoch: 2 } } },
      ]);
      yield* emit(nativeId, "after-release");
      yield* store.write([
        {
          type: "session",
          value: {
            ...initial,
            connectionId: "connection-two",
            controller: { type: "t3", epoch: 3 },
          },
        },
      ]);
      yield* emit(nativeId, "obsolete-generation");
      expect(yield* Queue.takeAll(delivered)).toEqual(["selected", "drain-completion"]);
      yield* protocol.notify("initialized");
    }).pipe(Effect.provide(testLayer([]))),
);

it.effect(
  "rejects a committed permission restriction at native enrollment before opening the runtime",
  () =>
    Effect.gen(function* () {
      const enrolling = yield* Deferred.make<void>();
      const continueEnrollment = yield* Deferred.make<void>();
      const calls: string[] = [];
      yield* Effect.gen(function* () {
        const adopt = yield* fixture;
        const service = yield* NativeSessionService.NativeSessionService;
        const pending = yield* service.adopt(adopt).pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(enrolling);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const thread = (yield* projections.getThreadProjection(threadId)).thread;
        const now = yield* DateTime.now;
        const restricted = yield* (yield* EventSink.EventSinkV2)
          .commitCommand({
            commandId: CommandId.make("restrict-before-enrollment"),
            threadId,
            commandType: "thread.runtime-mode.set",
            acceptedAt: now,
            effects: [],
            events: [
              {
                id: EventId.make("restrict-before-enrollment"),
                threadId,
                occurredAt: now,
                type: "thread.runtime-mode-updated",
                payload: { ...thread, runtimeMode: "approval-required", updatedAt: now },
              },
            ],
          })
          .pipe(Effect.provideService(EventSink.NativeCommandAdmission, { threadId, epoch: null }));
        expect(restricted.receipt.status).toBe("accepted");
        yield* Deferred.succeed(continueEnrollment, undefined);
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "Failure",
          failure: { code: "thread-policy-changed" },
        });
        expect((yield* projections.getThreadProjection(threadId)).thread.runtimeMode).toBe(
          "approval-required",
        );
        expect(
          Option.isNone(yield* (yield* NativeSessionStore.NativeSessionStore).get(threadId)),
        ).toBe(true);
        expect(calls).toEqual([]);
      }).pipe(
        Effect.provide(
          testLayer(calls, {
            beforeOpen: () =>
              Effect.sync(() => {
                calls.push("open");
              }),
            beforeWrite: (entries) =>
              entries.some((e) => e.type === "session" && e.value.controller.type === "adopting")
                ? Deferred.succeed(enrolling, undefined).pipe(
                    Effect.andThen(Deferred.await(continueEnrollment)),
                  )
                : Effect.void,
          }),
        ),
      );
    }),
);

it.effect.each([
  ["thread.runtime-mode.set", "thread.runtime-mode-updated", { runtimeMode: "approval-required" }],
  [
    "thread.model-selection.set",
    "thread.model-selection-updated",
    { modelSelection: { instanceId: providerInstanceId, model: "different-model" } },
  ],
  ["thread.interaction-mode.set", "thread.interaction-mode-updated", { interactionMode: "plan" }],
  ["thread.metadata.update", "thread.metadata-updated", { worktreePath: "/different-workspace" }],
  [
    "provider.switch",
    "thread.provider-switched",
    { providerInstanceId: ProviderInstanceId.make("other-provider") },
  ],
] as const)(
  "fences preauthorized %s after enrollment without locking native callbacks",
  ([commandType, type, patch]) =>
    Effect.gen(function* () {
      const opening = yield* Deferred.make<void>();
      const continueOpen = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const adopt = yield* fixture;
        const service = yield* NativeSessionService.NativeSessionService;
        const admission = yield* service.authorizeCommand({
          type: "thread.runtime-mode.set",
          threadId,
        } as never);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const prior = (yield* projections.getThreadProjection(threadId)).thread;
        const pending = yield* service.adopt(adopt).pipe(Effect.forkScoped);
        yield* Deferred.await(opening);
        const now = yield* DateTime.now;
        const committed = yield* (yield* EventSink.EventSinkV2)
          .commitCommand({
            commandId: CommandId.make("late-policy-change"),
            threadId,
            commandType,
            acceptedAt: now,
            effects: [],
            events: [
              {
                id: EventId.make("late-policy-change"),
                threadId,
                occurredAt: now,
                type,
                payload: { ...prior, ...patch },
              },
            ],
          })
          .pipe(Effect.provideService(EventSink.NativeCommandAdmission, admission));
        expect(committed.receipt.status).toBe("rejected");
        expect(committed.storedEvents).toEqual([]);
        expect((yield* projections.getThreadProjection(threadId)).thread).toEqual(prior);
        yield* Deferred.succeed(continueOpen, undefined);
        expect((yield* Fiber.join(pending)).state).toBe("ready");
      }).pipe(
        Effect.provide(
          testLayer([], {
            beforeOpen: () =>
              Deferred.succeed(opening, undefined).pipe(
                Effect.andThen(Deferred.await(continueOpen)),
              ),
          }),
        ),
      );
    }),
);

it.effect(
  "merges only native reasoning at readiness while preserving committed metadata and restrictive settings",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const continueReady = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const adopt = yield* fixture;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const prior = (yield* projections.getThreadProjection(threadId)).thread;
        const now = yield* DateTime.now;
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("initial-restriction"),
              threadId,
              occurredAt: now,
              type: "thread.runtime-mode-updated",
              payload: {
                ...prior,
                runtimeMode: "approval-required",
                modelSelection: {
                  ...prior.modelSelection,
                  options: [
                    { id: "reasoningEffort", value: "low" },
                    { id: "serviceTier", value: "priority" },
                  ],
                },
              },
            },
          ],
        });
        const pending = yield* (yield* NativeSessionService.NativeSessionService)
          .adopt({
            ...adopt,
            settings: {
              ...adopt.settings,
              approvalPolicy: "untrusted",
              sandboxPolicy: { type: "readOnly" },
            },
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(ready);
        const current = (yield* projections.getThreadProjection(threadId)).thread;
        const metadata = {
          ...current,
          title: "Concurrent title",
          pinnedAt: now,
          pinOrderKey: "pin-1",
          lastVisitedAt: now,
        };
        const events = yield* EventStore.EventStoreV2;
        const sequence = yield* events.latestSequence({ threadId });
        const pinned = yield* (yield* EventSink.EventSinkV2).commitCommand({
          commandId: CommandId.make("metadata-during-readiness"),
          threadId,
          commandType: "thread.pin",
          acceptedAt: now,
          effects: [],
          events: [
            {
              id: EventId.make("metadata-during-readiness"),
              threadId,
              occurredAt: now,
              type: "thread.pinned",
              payload: metadata,
            },
          ],
        });
        expect(pinned.receipt.status).toBe("accepted");
        yield* Deferred.succeed(continueReady, undefined);
        expect((yield* Fiber.join(pending)).state).toBe("ready");
        let client = { ...(yield* projections.getThreadProjection(threadId)), thread: current };
        let replay = client;
        for (const stored of yield* events
          .read({ threadId, afterSequence: sequence })
          .pipe(Stream.runCollect)) {
          client = applyOrchestrationV2ProjectionEvent(client, stored.event)!;
          replay = ProjectionStore.applyToProjection(replay, stored.event);
        }
        for (const state of [yield* projections.getThreadProjection(threadId), client, replay]) {
          expect(state.thread).toMatchObject({
            title: "Concurrent title",
            pinnedAt: now,
            pinOrderKey: "pin-1",
            lastVisitedAt: now,
            runtimeMode: "approval-required",
          });
          expect(state.thread.modelSelection.options).toEqual([
            { id: "serviceTier", value: "priority" },
            { id: "reasoningEffort", value: "high" },
          ]);
        }
      }).pipe(
        Effect.provide(
          testLayer([], {
            beforeWrite: (entries) =>
              entries.some((e) => e.type === "session" && e.value.controller.type === "t3")
                ? Deferred.succeed(ready, undefined).pipe(
                    Effect.andThen(Deferred.await(continueReady)),
                  )
                : Effect.void,
          }),
        ),
      );
    }),
);

it.effect.each([
  "provider.switch",
  "thread.model-selection.set",
  "message.dispatch",
  "delegated_task.request",
] as const)(
  "rejects foreign-instance %s through ThreadManagement before orchestration effects",
  (commandType) => {
    const dispatched: string[] = [];
    const layer = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.unwrap(
            Effect.gen(function* () {
              const projections = yield* ProjectionStore.ProjectionStoreV2;
              return Layer.mock(Orchestrator.OrchestratorV2)({
                getThreadRecords: (id, fields, filter) =>
                  projections.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
                dispatch: (command) =>
                  Effect.sync(() => {
                    dispatched.push(command.type);
                    return { sequence: 1, storedEvents: [] };
                  }),
              });
            }),
          ),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          ServerSettings.layerTest({
            providerInstances: {
              [providerInstanceId]: { driver: "codex", enabled: true },
              [ProviderInstanceId.make("codex-other")]: { driver: "codex", enabled: true },
            },
          }),
          CommandReceiptStore.layer,
        ),
      ),
      Layer.provideMerge(testLayer([])),
    );
    return Effect.gen(function* () {
      const adopt = yield* fixture;
      yield* (yield* NativeSessionService.NativeSessionService).adopt(adopt);
      const command = yield* decodeCommand({
        type: commandType,
        commandId: "foreign-instance-command",
        threadId,
        parentThreadId: threadId,
        parentRunId: "parent-run",
        parentNodeId: "parent-node",
        task: "Child task",
        text: "New message",
        messageId: "foreign-message",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        modelSelection: {
          instanceId: "codex-other",
          model: adopt.settings.model,
          options: [{ id: "reasoningEffort", value: adopt.settings.reasoningEffort }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      });
      expect(
        yield* Effect.result(
          (yield* ThreadManagementService.ThreadManagementService).dispatch(command),
        ),
      ).toMatchObject({
        _tag: "Failure",
        failure: { cause: { code: "adopted-settings-change-unsupported" } },
      });
      expect(dispatched).toEqual([]);
      expect(
        (yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(threadId)).thread
          .providerInstanceId,
      ).toBe(providerInstanceId);
      expect(
        Option.getOrThrow(yield* (yield* NativeSessionStore.NativeSessionStore).get(threadId))
          .providerInstanceId,
      ).toBe(providerInstanceId);
    }).pipe(Effect.provide(layer));
  },
);
it.effect("rejects the actual provider.switch command even for the native binding instance", () =>
  Effect.gen(function* () {
    const adopt = yield* fixture;
    const service = yield* NativeSessionService.NativeSessionService;
    yield* service.adopt(adopt);
    const command = yield* decodeCommand({
      type: "provider.switch",
      commandId: "same-instance-switch",
      threadId,
      modelSelection: { instanceId: providerInstanceId, model: adopt.settings.model },
    });
    expect(yield* Effect.result(service.authorizeCommand(command))).toMatchObject({
      _tag: "Failure",
      failure: { code: "adopted-operation-unsupported" },
    });
  }).pipe(Effect.provide(testLayer([]))),
);

it.effect("retries adoption at the same time after readiness commits but its receipt fails", () => {
  let failed = false;
  const calls: string[] = [];
  return Effect.gen(function* () {
    const adopt = yield* fixture;
    const service = yield* NativeSessionService.NativeSessionService;
    const first = yield* service.adopt(adopt);
    expect(first.state).toBe("blocked");
    expect(first.blockers.map((b) => b.code)).toContain("receipt-write-failed");
    const ready = yield* service.adopt(adopt);
    expect(ready.state).toBe("ready");
    expect(yield* service.adopt(adopt)).toEqual(ready);
    expect(calls).toEqual(["resume"]);
  }).pipe(
    Effect.provide(
      testLayer(calls, {
        beforeWrite: (entries) =>
          Effect.suspend(() => {
            if (
              !failed &&
              entries.some((e) => e.type === "operation" && e.value.result?.state === "ready")
            ) {
              failed = true;
              return new NativeSessionError({ code: "receipt-write-failed", threadId });
            }
            return Effect.void;
          }),
      }),
    ),
  );
});

it.effect("rejects a preauthorized actual deletion plan after native enrollment", () =>
  Effect.gen(function* () {
    const adopt = yield* fixture;
    const service = yield* NativeSessionService.NativeSessionService;
    const command = {
      type: "thread.delete" as const,
      commandId: CommandId.make("late-native-delete"),
      threadId,
    } satisfies OrchestrationV2Command;
    const admission = yield* service.authorizeCommand(command);
    expect(admission).toEqual({ threadId, epoch: null });
    expect((yield* service.adopt(adopt)).state).toBe("ready");
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const store = yield* NativeSessionStore.NativeSessionStore;
    const projection = yield* projections.getThreadProjection(threadId);
    const binding = yield* store.get(threadId);
    const now = yield* DateTime.now;
    const plan = yield* planThreadDeletion({
      command,
      projection,
      attachmentIds: ["synthetic-attachment"],
      now,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
    });
    expect(plan.events.map((event) => event.type)).toEqual(["thread.deleted"]);
    expect(plan.effects.map((effect) => effect.request.type)).toEqual([
      "scheduled-tasks.cleanup",
      "terminal.cleanup",
      "preview.cleanup",
      "attachment.cleanup",
    ]);
    const committed = yield* (yield* EventSink.EventSinkV2)
      .commitCommand({
        commandId: command.commandId,
        threadId,
        commandType: command.type,
        acceptedAt: now,
        ...plan,
      })
      .pipe(Effect.provideService(EventSink.NativeCommandAdmission, admission));
    expect(committed.receipt.status).toBe("rejected");
    expect(committed.storedEvents).toEqual([]);
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT effect_type FROM orchestration_v2_effect_outbox`).toEqual([]);
    expect(
      yield* (yield* EventStore.EventStoreV2)
        .readByCommandId({ commandId: command.commandId })
        .pipe(Stream.runCollect),
    ).toEqual([]);
    expect(yield* projections.getThreadProjection(threadId)).toEqual(projection);
    expect(yield* store.get(threadId)).toEqual(binding);
  }).pipe(Effect.provide(testLayer([]))),
);

it.effect.each([false, true])(
  "uses the actual archive plan with native enrollment %s and never executes cleanup",
  (enrolled) => {
    const adapter = {
      instanceId: providerInstanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
      openSession: () => Effect.die("Archive planning must not open a native client"),
    } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
    const archiveLayer = ProviderReplayHarness.layerWithRegistry(
      { name: "native-late-archive" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: Sqlite.layerMemory, runEffectWorker: false },
    );
    return Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      const command = OrchestrationV2Command.make({
        type: "thread.archive",
        commandId: CommandId.make("late-native-archive"),
        threadId,
      });
      const admission = yield* service.authorizeCommand(command);
      expect(admission).toEqual({ threadId, epoch: null });
      if (enrolled) expect((yield* service.adopt(adopt)).state).toBe("ready");
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const projection = yield* projections.getThreadProjection(threadId);
      const store = yield* NativeSessionStore.NativeSessionStore;
      const binding = yield* store.get(threadId);
      const dispatched = yield* (yield* Orchestrator.OrchestratorV2)
        .dispatch(command)
        .pipe(Effect.provideService(EventSink.NativeCommandAdmission, admission), Effect.result);
      const sql = yield* SqlClient.SqlClient;
      const receipts = yield* sql<{
        status: string;
      }>`SELECT status FROM orchestration_command_receipts WHERE command_id = ${command.commandId}`;
      const outbox = yield* sql<{
        effect_type: string;
      }>`SELECT effect_type FROM orchestration_v2_effect_outbox WHERE command_id = ${command.commandId}`;
      const events = yield* (yield* EventStore.EventStoreV2)
        .readByCommandId({ commandId: command.commandId })
        .pipe(Stream.runCollect);
      if (enrolled) {
        expect(dispatched._tag).toBe("Failure");
        expect(receipts).toEqual([{ status: "rejected" }]);
        expect(events).toEqual([]);
        expect(outbox).toEqual([]);
        expect(yield* projections.getThreadProjection(threadId)).toEqual(projection);
      } else {
        expect(dispatched._tag).toBe("Success");
        expect(receipts).toEqual([{ status: "accepted" }]);
        expect(events.map((stored) => stored.event.type)).toEqual(["thread.archived"]);
        expect(outbox).toEqual([{ effect_type: "terminal.cleanup" }]);
        expect((yield* projections.getThreadProjection(threadId)).thread.archivedAt).not.toBeNull();
      }
      expect(yield* store.get(threadId)).toEqual(binding);
    }).pipe(Effect.provide(Layer.merge(testLayer([]), archiveLayer)));
  },
);

it.effect.each([
  { type: "thread.archive" },
  { type: "thread.unarchive" },
  { type: "thread.delete" },
  { type: "thread.settle" },
  { type: "thread.auto-settle", snapshotAt: DateTime.makeUnsafe("1970-01-01T00:00:00Z") },
  { type: "thread.runtime-mode.set", runtimeMode: "full-access" },
  { type: "thread.interaction-mode.set", interactionMode: "default" },
  {
    type: "thread.model-selection.set",
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  },
  { type: "provider.switch", modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" } },
  { type: "provider-session.detach", providerSessionId: "native-session" },
  { type: "checkpoint.rollback", checkpointId: "checkpoint", scopeId: "scope" },
  {
    type: "thread.fork",
    sourceThreadId: threadId,
    targetThreadId: "child",
    sourcePoint: { type: "latest_stable" },
    createdBy: "user",
    creationSource: "web",
  },
])("rejects unsupported native $type at authorization and late transactional commit", (payload) =>
  Effect.gen(function* () {
    const adopt = yield* fixture;
    const service = yield* NativeSessionService.NativeSessionService;
    const command = yield* decodeCommand({ ...payload, threadId, commandId: "late-unsupported" });
    const admission = yield* service.authorizeCommand(command);
    expect(admission).toEqual({ threadId, epoch: null });
    expect((yield* service.adopt(adopt)).state).toBe("ready");
    expect(yield* Effect.result(service.authorizeCommand(command))).toMatchObject({
      _tag: "Failure",
      failure: { code: "adopted-operation-unsupported" },
    });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projection = yield* projections.getThreadProjection(threadId);
    const store = yield* NativeSessionStore.NativeSessionStore;
    const binding = yield* store.get(threadId);
    const now = yield* DateTime.now;
    const commitThreadId = command.type === "thread.fork" ? command.targetThreadId : threadId;
    const committed = yield* (yield* EventSink.EventSinkV2)
      .commitCommand({
        commandId: command.commandId,
        threadId: commitThreadId,
        commandType: command.type,
        acceptedAt: now,
        events: [
          {
            id: EventId.make("unsupported-event"),
            type: command.type === "thread.fork" ? "thread.created" : "thread.metadata-updated",
            threadId: commitThreadId,
            occurredAt: now,
            payload: { ...projection.thread, id: commitThreadId, title: "Forbidden change" },
          },
        ],
        effects: [],
      })
      .pipe(Effect.provideService(EventSink.NativeCommandAdmission, admission));
    expect(committed.receipt.status).toBe("rejected");
    expect(committed.storedEvents).toEqual([]);
    expect(yield* projections.getThreadProjection(threadId)).toEqual(projection);
    expect(yield* store.get(threadId)).toEqual(binding);
  }).pipe(Effect.provide(testLayer([]))),
);

it.effect(
  "keeps a preauthorized title edit while rebasing only native policy on its selected thread",
  () =>
    Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const prior = (yield* projections.getThreadProjection(threadId)).thread;
      const command = yield* decodeCommand({
        type: "thread.metadata.update",
        commandId: "late-title",
        threadId,
        title: "New title",
      });
      const admission = yield* service.authorizeCommand(command);
      expect(admission).toEqual({ threadId, epoch: null });
      expect(
        (yield* service.adopt({
          ...adopt,
          settings: { ...adopt.settings, reasoningEffort: "ultra" },
        })).state,
      ).toBe("ready");
      const current = (yield* projections.getThreadProjection(threadId)).thread;
      const now = yield* DateTime.now;
      const committed = yield* (yield* EventSink.EventSinkV2)
        .commitCommand({
          commandId: command.commandId,
          threadId,
          commandType: command.type,
          acceptedAt: now,
          effects: [],
          events: [
            {
              id: EventId.make("late-title"),
              threadId,
              occurredAt: now,
              type: "thread.metadata-updated",
              payload: { ...prior, title: "New title", updatedAt: now },
            },
          ],
        })
        .pipe(Effect.provideService(EventSink.NativeCommandAdmission, admission));
      expect(committed.receipt.status).toBe("accepted");
      expect((yield* projections.getThreadProjection(threadId)).thread).toEqual({
        ...current,
        title: "New title",
        updatedAt: now,
      });
    }).pipe(Effect.provide(testLayer([]))),
);

it.effect.each(["/work", "/child-workspace"])(
  "preserves child thread events at %s when its native parent commits delegated work",
  (worktreePath) =>
    Effect.gen(function* () {
      const adopt = yield* fixture;
      const service = yield* NativeSessionService.NativeSessionService;
      yield* service.adopt(adopt);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = (yield* projections.getThreadProjection(threadId)).thread;
      const childId = ThreadId.make("app-child");
      const child = {
        ...parent,
        id: childId,
        title: "Delegated child",
        worktreePath,
        activeProviderThreadId: null,
        modelSelection: {
          ...parent.modelSelection,
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ],
        },
        lineage: {
          ...parent.lineage,
          parentThreadId: threadId,
          relationshipToParent: "subagent" as const,
        },
      };
      const now = yield* DateTime.now;
      const command = yield* decodeCommand({
        type: "delegated_task.request",
        commandId: "native-parent-child",
        parentThreadId: threadId,
        parentRunId: "parent-run",
        parentNodeId: "parent-node",
        task: "Child task",
        modelSelection: parent.modelSelection,
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        createdBy: "user",
        creationSource: "web",
      });
      const admission = yield* service.authorizeCommand(command);
      const committed = yield* (yield* EventSink.EventSinkV2)
        .commitCommand({
          commandId: CommandId.make("native-parent-child"),
          threadId,
          commandType: command.type,
          acceptedAt: now,
          effects: [],
          events: [
            {
              id: EventId.make("native-parent-child"),
              threadId: childId,
              occurredAt: now,
              type: "thread.created",
              payload: child,
            },
          ],
        })
        .pipe(Effect.provideService(EventSink.NativeCommandAdmission, admission));
      expect(committed.receipt.status).toBe("accepted");
      expect((yield* projections.getThreadProjection(threadId)).thread).toEqual(parent);
      expect((yield* projections.getThreadProjection(childId)).thread).toEqual(child);
    }).pipe(Effect.provide(testLayer([]))),
);

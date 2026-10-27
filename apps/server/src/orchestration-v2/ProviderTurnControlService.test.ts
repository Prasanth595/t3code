import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeProjection(input: {
  readonly now: DateTime.Utc;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId: RunAttemptId;
}): OrchestrationV2ThreadProjection {
  const runId = RunId.make("run:restart-session");
  const nodeId = NodeId.make("node:restart-session");
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make("project:restart-session"),
      title: "Restart session",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [
      {
        id: input.attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId: input.providerThread.id,
        providerTurnId: input.providerTurnId,
        reason: "initial",
        status: "superseded",
        startedAt: input.now,
        completedAt: input.now,
      },
    ],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [input.providerThread],
    providerTurns: [
      {
        id: input.providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: {
          driver,
          nativeId: "native-turn:restart-session",
          strength: "strong",
        },
        ordinal: 1,
        status: "running",
        startedAt: input.now,
        completedAt: null,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: input.now,
  };
}

it.effect(
  "interrupts the historical session only for the exact committed restart replacement",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-session");
      const oldSessionId = ProviderSessionId.make("provider-session:restart-session:old");
      const replacementSessionId = ProviderSessionId.make(
        "provider-session:restart-session:replacement",
      );
      const unrelatedSessionId = ProviderSessionId.make(
        "provider-session:restart-session:unrelated",
      );
      const providerThreadId = ProviderThreadId.make("provider-thread:restart-session");
      const providerTurnId = ProviderTurnId.make("provider-turn:restart-session");
      const attemptId = RunAttemptId.make("run-attempt:restart-session");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: replacementSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:restart-session",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = yield* Ref.make(
        makeProjection({ now, threadId, providerThread, providerTurnId, attemptId }),
      );
      const interruptedThread = yield* Ref.make<OrchestrationV2ProviderThread | null>(null);
      const providerSession = {
        id: oldSessionId,
        driver,
        providerInstanceId,
        status: "running" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId: oldSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () => Effect.die("unused steerTurn"),
        interruptTurn: ({ providerThread: target }) =>
          Effect.all(
            [
              Ref.set(interruptedThread, target),
              Ref.update(projection, (current) => ({
                ...current,
                providerTurns: current.providerTurns.map((turn) =>
                  turn.id === providerTurnId
                    ? { ...turn, status: "interrupted" as const, completedAt: now }
                    : turn,
                ),
              })),
            ],
            { discard: true },
          ),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const layerProjection = Layer.succeed(
        ProjectionStore.ProjectionStoreV2,
        ProjectionStore.ProjectionStoreV2.of({
          apply: () => Effect.void,
          getLimitRecoveryCandidates: () => Effect.die("unused getLimitRecoveryCandidates"),
          getShellSnapshot: () => Effect.die("unused getShellSnapshot"),
          listActiveSubagentThreadIds: () => Effect.die("unused listActiveSubagentThreadIds"),
          listOlderSettledThreads: () => Effect.die("unused listOlderSettledThreads"),
          readShellSnapshot: () => Effect.die("unused readShellSnapshot"),
          getThreadShell: () => Effect.die("unused getThreadShell"),
          findGuestShareThreadId: () => Effect.die("unused findGuestShareThreadId"),
          getThread: () => Ref.get(projection).pipe(Effect.map((state) => state.thread)),
          getSettlementCandidates: () => Effect.die("unused getSettlementCandidates"),
          getThreadsWithPullRequests: () => Effect.die("unused getThreadsWithPullRequests"),
          getThreadWorktreePaths: () => Effect.die("unused getThreadWorktreePaths"),
          getThreadProjection: () => Effect.die("control effects must not load transcript"),
          getTurnStartContext: () => Effect.die("unused"),
          getTurnStartHistory: () => Effect.die("unused"),
          getRuntimeRecoveryProjection: () => Effect.die("unused getRuntimeRecoveryProjection"),
          getPlan: () => Effect.die("unused"),
          hasUnpairedRunInterruptRequest: () => Effect.die("unused interrupt read"),
          getThreadAttachmentIds: () => Effect.die("Unused attachment lookup"),
          searchThread: () => Effect.die("unused"),
          searchThreadStream: () => Stream.empty,
          getThreadHistoryPage: () => Effect.die("unused"),
          getTimelinePage: () => Effect.die("Unused timeline read"),
          getMessageCount: () => Effect.die("unused message count"),
          getNextTurnItemOrdinal: () => Effect.die("unused ordinal read"),
          getTurnItem: () => Effect.die("unused turn item read"),
          getThreadRecords: () => Effect.die("unused record read"),
          getRuntimeRequest: () => Effect.die("unused getRuntimeRequest"),
          getRunningTurnContext: () => Effect.die("unused getRunningTurnContext"),
          getThreadProviderContext: () => Effect.die("unused getThreadProviderContext"),
          getRuntimeResponseContext: () => Effect.die("unused getRuntimeResponseContext"),
          getPendingNativeUserInputs: () => Effect.die("unused getPendingNativeUserInputs"),
          getProviderControlContext: (_threadId, target) =>
            Ref.get(projection).pipe(
              Effect.map((current) => ({
                providerThread: current.providerThreads.find(
                  (thread) => thread.id === target.providerThreadId,
                ),
                providerTurn: current.providerTurns.find(
                  (turn) => turn.id === target.providerTurnId,
                ),
                attempt: current.attempts.find((attempt) => attempt.id === target.attemptId),
                message: undefined,
                run: undefined,
              })),
            ),
          getCheckpointContext: () => Effect.die("not used"),
          getCheckpointRollbackContext: () => Effect.die("unused rollback context"),
          getCheckpointCaptureContext: () => Effect.die("not used"),
          getRunMessage: () => Effect.die("not used"),
          isNodeStored: () => Effect.die("not used"),
          canStartQueuedRun: () => Effect.die("not used"),
          getRecoveryThreadIds: () => Effect.die("unused getRecoveryThreadIds"),
          getUnreadableThreadIds: () => Effect.die("unused getUnreadableThreadIds"),
          getThreadSnapshot: () => Effect.die("unused getThreadSnapshot"),
          getThreadSnapshotWindow: () => Effect.die("unused getThreadSnapshotWindow"),
        }),
      );
      const layerSessionManager = Layer.succeed(
        ProviderSessionManager.ProviderSessionManagerV2,
        ProviderSessionManager.ProviderSessionManagerV2.of({
          shutdown: Effect.void,
          open: () => Effect.die("unused open"),
          get: (providerSessionId) =>
            Effect.succeed(
              providerSessionId === oldSessionId ? Option.some(runtime) : Option.none(),
            ),
          isLive: (providerSessionId) => Effect.succeed(providerSessionId === oldSessionId),
          close: () => Effect.void,
          closeInstance: () => Effect.void,
          release: () => Effect.void,
          detach: () => Effect.void,
        }),
      );
      const layerControl = ProviderTurnControlService.layer.pipe(
        Layer.provide(Layer.merge(layerProjection, layerSessionManager)),
      );

      const [ordinaryInterrupt, unrelatedRestart] = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const ordinary = yield* Effect.exit(
          control.interrupt({
            threadId,
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
          }),
        );
        const unrelated = yield* Effect.exit(
          control.interruptAndAwaitTerminal({
            threadId,
            providerSessionId: oldSessionId,
            replacementProviderSessionId: unrelatedSessionId,
            providerThreadId,
            providerTurnId,
            interruptedAttemptId: attemptId,
          }),
        );
        return [ordinary, unrelated] as const;
      }).pipe(Effect.provide(layerControl));

      assert.isTrue(Exit.isFailure(ordinaryInterrupt));
      assert.isTrue(Exit.isFailure(unrelatedRestart));
      assert.isNull(yield* Ref.get(interruptedThread));

      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        yield* control.interruptAndAwaitTerminal({
          threadId,
          providerSessionId: oldSessionId,
          replacementProviderSessionId: replacementSessionId,
          providerThreadId,
          providerTurnId,
          interruptedAttemptId: attemptId,
        });
      }).pipe(Effect.provide(layerControl));

      const interrupted = yield* Ref.get(interruptedThread);
      assert.isNotNull(interrupted);
      assert.equal(interrupted?.providerSessionId, oldSessionId);
      assert.equal(interrupted?.id, providerThreadId);
      assert.equal(interrupted?.nativeThreadRef?.nativeId, "native-thread:restart-session");
    }),
);

const steerBody = "Please merge the PR now.";
const steerChildThreadId = ThreadId.make("thread:child-review");

function dyingProjectionStore(
  implemented: Partial<ProjectionStore.ProjectionStoreV2["Service"]>,
): ProjectionStore.ProjectionStoreV2["Service"] {
  return new Proxy(implemented, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      return () => Effect.die(`unused ${String(property)}`);
    },
  }) as ProjectionStore.ProjectionStoreV2["Service"];
}

function steerProviderText(input: {
  readonly createdBy: OrchestrationV2ConversationMessage["createdBy"];
  readonly creationSource: OrchestrationV2ConversationMessage["creationSource"];
  readonly senderThreadId?: ThreadId;
  readonly senderTitle?: string;
  readonly senderLookupFails?: boolean;
  readonly text?: string;
  readonly attachments?: OrchestrationV2ConversationMessage["attachments"];
  readonly subagents?: ReadonlyArray<{
    readonly origin: "app_owned" | "provider_native";
    readonly childThreadId: ThreadId | null;
  }>;
  readonly subagentLookupFails?: boolean;
}) {
  return Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:steer-provenance");
    const providerSessionId = ProviderSessionId.make("provider-session:steer-provenance");
    const providerThreadId = ProviderThreadId.make("provider-thread:steer-provenance");
    const providerTurnId = ProviderTurnId.make("provider-turn:steer-provenance");
    const messageId = MessageId.make("message:steer-provenance");
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver,
        nativeId: "native-thread:steer-provenance",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    const message: OrchestrationV2ConversationMessage = {
      id: messageId,
      threadId,
      runId: RunId.make("run:steer-provenance"),
      nodeId: NodeId.make("node:steer-provenance"),
      role: "user",
      text: input.text ?? steerBody,
      attachments: input.attachments ?? [],
      streaming: false,
      createdBy: input.createdBy,
      creationSource: input.creationSource,
      ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
      createdAt: now,
      updatedAt: now,
    };
    const steered = yield* Ref.make<string | undefined>(undefined);
    const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
      instanceId: providerInstanceId,
      driver,
      providerSessionId,
      providerSession: {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "running",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
      events: Stream.empty,
      ensureThread: () => Effect.die("unused ensureThread"),
      resumeThread: () => Effect.die("unused resumeThread"),
      startTurn: () => Effect.die("unused startTurn"),
      steerTurn: (request) => Ref.set(steered, request.message.text),
      interruptTurn: () => Effect.die("unused interruptTurn"),
      respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
      readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
      rollbackThread: () => Effect.die("unused rollbackThread"),
      forkThread: () => Effect.die("unused forkThread"),
    };
    const layer = ProviderTurnControlService.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(
            ProjectionStore.ProjectionStoreV2,
            ProjectionStore.ProjectionStoreV2.of(
              dyingProjectionStore({
                getProviderControlContext: () =>
                  Effect.succeed({
                    providerThread,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId,
                      nodeId: NodeId.make("node:steer-provenance"),
                      runAttemptId: RunAttemptId.make("run-attempt:steer-provenance"),
                      nativeTurnRef: null,
                      ordinal: 1,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                    attempt: undefined,
                    message,
                    run: {
                      id: RunId.make("run:steer-provenance"),
                    } as OrchestrationV2ThreadProjection["runs"][number],
                  }),
                getThread: (requestedThreadId) =>
                  input.createdBy === "user"
                    ? Effect.die("user messages do not look up a sender")
                    : input.senderLookupFails === true
                      ? Effect.fail(
                          new ProjectionStore.ProjectionStoreReadError({
                            threadId: requestedThreadId,
                            cause: "sender lookup failed",
                          }),
                        )
                      : Effect.succeed({
                          title: input.senderTitle ?? "Sender",
                        } as never),
                getThreadRecords: () =>
                  input.createdBy === "user"
                    ? Effect.die("user messages do not look up a sender")
                    : input.subagentLookupFails === true
                      ? Effect.fail(
                          new ProjectionStore.ProjectionStoreReadError({
                            threadId,
                            cause: "subagent lookup failed",
                          }),
                        )
                      : Effect.succeed({
                          subagents: input.subagents ?? [],
                        } as never),
              }),
            ),
          ),
          Layer.succeed(
            ProviderSessionManager.ProviderSessionManagerV2,
            ProviderSessionManager.ProviderSessionManagerV2.of({
              shutdown: Effect.void,
              open: () => Effect.die("unused open"),
              get: () => Effect.succeedSome(runtime),
              isLive: () => Effect.succeed(true),
              close: () => Effect.void,
              closeInstance: () => Effect.void,
              release: () => Effect.void,
              detach: () => Effect.void,
            }),
          ),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
      yield* control.steer({
        threadId,
        providerSessionId,
        providerThreadId,
        providerTurnId,
        messageId,
      });
    }).pipe(Effect.provide(layer));

    return yield* Ref.get(steered);
  });
}

it.effect.each([
  {
    label: "an agent thread send names the sender and is not the user",
    createdBy: "agent" as const,
    creationSource: "mcp" as const,
    senderThreadId: steerChildThreadId,
    senderTitle: "Review the PR",
    expected: `Agent-authored message from "Review the PR", not the user.\n${steerBody}`,
  },
  {
    label: "an agent send from this thread's delegated task says so",
    createdBy: "agent" as const,
    creationSource: "mcp" as const,
    senderThreadId: steerChildThreadId,
    senderTitle: "Review the PR",
    subagents: [{ origin: "app_owned" as const, childThreadId: steerChildThreadId }],
    expected: `Agent-authored message from your delegated task "Review the PR", not the user.\n${steerBody}`,
  },
  {
    label: "a failed sender lookup still delivers an id-only header",
    createdBy: "agent" as const,
    creationSource: "mcp" as const,
    senderThreadId: steerChildThreadId,
    senderLookupFails: true,
    subagents: [{ origin: "app_owned" as const, childThreadId: steerChildThreadId }],
    expected: `Agent-authored message from your delegated task ${steerChildThreadId}, not the user.\n${steerBody}`,
  },
  {
    label: "a failed relationship lookup does not claim a delegated task",
    createdBy: "agent" as const,
    creationSource: "mcp" as const,
    senderThreadId: steerChildThreadId,
    senderTitle: "Review the PR",
    subagentLookupFails: true,
    expected: `Agent-authored message from "Review the PR", not the user.\n${steerBody}`,
  },
  {
    label: "a user steer is unchanged",
    createdBy: "user" as const,
    creationSource: "web" as const,
    senderThreadId: steerChildThreadId,
    senderTitle: "Review the PR",
    expected: steerBody,
  },
  {
    label: "an agent steer with no sender thread is unchanged",
    createdBy: "agent" as const,
    creationSource: "server" as const,
    expected: steerBody,
  },
  {
    label: "an agent Cursor /compress stays raw",
    createdBy: "agent" as const,
    creationSource: "mcp" as const,
    senderThreadId: steerChildThreadId,
    senderTitle: "Review the PR",
    text: "/compress",
    expected: "/compress",
  },
  {
    label: "a mid-message skill mention still names the sender",
    createdBy: "agent" as const,
    creationSource: "mcp" as const,
    senderThreadId: steerChildThreadId,
    senderTitle: "Review the PR",
    text: "Ship $deploy now",
    expected: `Agent-authored message from "Review the PR", not the user.\nShip $deploy now`,
  },
])("steers provider text so $label", (input) =>
  Effect.gen(function* () {
    const text = yield* steerProviderText(input);
    assert.equal(text, input.expected);
  }),
);

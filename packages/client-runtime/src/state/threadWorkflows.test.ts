import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  SwarmId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";

import {
  canDetachThreadProviderSession,
  canForkProjectedAssistantItem,
  deriveThreadQueueWorkflowState,
  resolveLatestMergeBackRun,
  threadSupportsProviderHandoff,
} from "./threadWorkflows.ts";

const capabilities = (input?: {
  readonly queued?: boolean;
  readonly steer?: boolean;
  readonly restartSteer?: boolean;
  readonly nativeFork?: boolean;
  readonly portableFork?: boolean;
}): OrchestrationV2ProviderCapabilities => ({
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: false,
    emitsTurnCompleted: false,
    supportsInterrupt: false,
    supportsQueuedMessages: input?.queued ?? false,
    supportsActiveSteering: input?.steer ?? false,
    supportsSteeringByInterruptRestart: input?.restartSteer ?? false,
    terminalStatusQuality: "none",
  },
  threads: {
    canCreateEmptyThread: false,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: input?.nativeFork ?? false,
    canForkFromTurn: input?.nativeFork ?? false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: false,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  identity: {
    nativeThreadIds: input?.nativeFork ? "strong" : "none",
    nativeTurnIds: "none",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: input?.portableFork ?? false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  runtimePolicy: { enforcement: "client-boundary" },
});

describe("thread workflows", () => {
  it.each(["run", "message", "both", "missing message"])(
    "keeps %s peer provenance queue-only while ordinary messages remain editable and steerable",
    (provenance) => {
      const queued = (id: string, ordinal: number): OrchestrationV2Run => ({
        id: RunId.make(id),
        threadId: v2Projection.thread.id,
        ordinal,
        providerInstanceId: v2Projection.thread.providerInstanceId,
        modelSelection: v2Projection.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`${id}-message`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued",
        requestedAt: v2Now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      });
      const messageBase = {
        threadId: v2Projection.thread.id,
        nodeId: null,
        attachments: [],
        streaming: false,
        role: "user" as const,
        createdBy: "user" as const,
        creationSource: "web" as const,
        createdAt: v2Now,
        updatedAt: v2Now,
      };
      const peerDelivery: NonNullable<OrchestrationV2Run["swarmPeerDelivery"]> = {
        swarmId: SwarmId.make("swarm"),
        ownerThreadId: ThreadId.make("parent"),
        senderThreadId: ThreadId.make("a"),
        commandId: CommandId.make("peer-send"),
        runtimeMode: "full-access",
        interactionMode: "default",
      };
      const activeAttemptId = RunAttemptId.make("active-attempt");
      const providerThreadId = ProviderThreadId.make("provider-thread");
      for (const steering of ["native", "restart"]) {
        for (const queueHeld of [false, true]) {
          const state = deriveThreadQueueWorkflowState({
            ...v2Projection,
            runs: [
              { ...queued("active", 1), status: "running", activeAttemptId, providerThreadId },
              {
                ...queued("peer", 2),
                queueHeld,
                ...(provenance !== "message" ? { swarmPeerDelivery: peerDelivery } : {}),
              },
              queued("human", 3),
              queued("generic", 4),
            ],
            providerSessions: [
              {
                id: ProviderSessionId.make("provider-session"),
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: v2Projection.thread.providerInstanceId,
                status: "running",
                cwd: "/workspace/project",
                model: "gpt-5.4",
                capabilities: capabilities({
                  queued: true,
                  steer: steering === "native",
                  restartSteer: steering === "restart",
                }),
                createdAt: v2Now,
                updatedAt: v2Now,
                lastError: null,
              },
            ],
            providerTurns: [
              {
                id: ProviderTurnId.make("provider-turn"),
                providerThreadId,
                nodeId: NodeId.make("active-node"),
                runAttemptId: activeAttemptId,
                nativeTurnRef: null,
                ordinal: 1,
                status: "running",
                startedAt: v2Now,
                completedAt: null,
              },
            ],
            messages: [
              ...(provenance === "missing message"
                ? []
                : [
                    {
                      ...messageBase,
                      id: MessageId.make("peer-message"),
                      runId: RunId.make("peer"),
                      text: "Question",
                      senderThreadId: ThreadId.make("a"),
                      ...(provenance === "message" || provenance === "both"
                        ? { swarmPeerDelivery: peerDelivery }
                        : {}),
                    },
                  ]),
              {
                ...messageBase,
                id: MessageId.make("human-message"),
                runId: RunId.make("human"),
                text: "Human followup",
              },
              {
                ...messageBase,
                id: MessageId.make("generic-message"),
                runId: RunId.make("generic"),
                text: "Ordinary agent followup",
                createdBy: "agent",
                creationSource: "mcp",
                senderThreadId: ThreadId.make("b"),
              },
            ],
          });
          expect(
            state.queuedRuns.map((row) => ({
              text: row.text,
              edit: row.canEdit,
              steer: row.canPromoteToSteer,
              reason: row.queueOnlyReason,
            })),
          ).toEqual([
            {
              text: provenance === "missing message" ? "Queued message" : "Question",
              edit: false,
              steer: false,
              reason:
                "Peer messages must stay queued and cannot be edited or sent as a steer. Cancel this message and send a new ordinary message from your composer.",
            },
            { text: "Human followup", edit: true, steer: true, reason: null },
            { text: "Ordinary agent followup", edit: true, steer: true, reason: null },
          ]);
          expect(state.canPromoteToSteer).toBe(true);
          expect(state.canReorder).toBe(true);
          expect(state.isHeld).toBe(queueHeld);
        }
      }
    },
  );
  it("allows a completed thread to switch providers after its session detaches", () => {
    const projection = {
      thread: {
        id: "thread",
        activeProviderThreadId: "provider-thread",
        modelSelection: { instanceId: "cursor", model: "grok-4.7" },
      },
      runs: [{ id: "run", status: "completed" }],
      providerSessions: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerInstanceId: "cursor",
          providerSessionId: "detached-session",
          nativeThreadRef: { driver: "cursor", nativeId: "agent-123", strength: "strong" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;

    expect(threadSupportsProviderHandoff(projection)).toBe(true);
    expect(
      threadSupportsProviderHandoff({
        ...projection,
        runs: [{ ...projection.runs[0]!, status: "running" }],
      }),
    ).toBe(false);
    expect(
      threadSupportsProviderHandoff({
        ...projection,
        providerThreads: [{ ...projection.providerThreads[0]!, nativeThreadRef: null }],
      }),
    ).toBe(false);
  });

  it("sorts queued messages and gates reorder and promotion from capabilities", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "active",
          status: "running",
          providerThreadId: "provider-thread",
          activeAttemptId: "attempt-active",
          ordinal: 1,
        },
        { id: "later", status: "queued", userMessageId: "message-later", ordinal: 3 },
        {
          id: "first",
          status: "queued",
          userMessageId: "message-first",
          ordinal: 2,
          queuePosition: 1,
        },
      ],
      messages: [
        {
          id: "message-first",
          text: "First",
          attachments: [
            {
              type: "image",
              id: "attachment-first",
              name: "first.png",
              mimeType: "image/png",
              sizeBytes: 64,
            },
          ],
        },
        { id: "message-later", text: "Later" },
      ],
      providerTurns: [
        {
          id: "provider-turn-active",
          runAttemptId: "attempt-active",
          status: "running",
        },
      ],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "running",
          capabilities: capabilities({ queued: true, restartSteer: true }),
        },
      ],
    } as never);

    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["first", "First"],
      ["later", "Later"],
    ]);
    expect(state.queuedRuns.map(({ attachments }) => attachments.map(({ id }) => id))).toEqual([
      ["attachment-first"],
      [],
    ]);
    expect(state.activeRun?.id).toBe("active");
    expect(state.canReorder).toBe(true);
    expect(state.canPromoteToSteer).toBe(true);
    expect(state.queuedRuns.map((row) => [row.canEdit, row.canPromoteToSteer])).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  it("keeps held messages visible and clears the hold when they leave the queue", () => {
    for (const status of ["queued", "cancelled", "starting"] as const) {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: null },
        runs: [{ id: "held", status, userMessageId: "message", ordinal: 1, queueHeld: true }],
        messages: [{ id: "message", text: "Saved message" }],
        providerThreads: [],
        providerTurns: [],
        providerSessions: [],
      } as never);
      expect(state.isHeld).toBe(status === "queued");
      expect(state.queuedRuns.map(({ text }) => text)).toEqual(
        status === "queued" ? ["Saved message"] : [],
      );
    }
  });

  it("hides automatic completion delivery from the visible queue", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: null },
      runs: [
        {
          id: "provider-wake",
          status: "queued",
          userMessageId: "provider-wake",
          ordinal: 4,
          queuePosition: 3,
        },
        {
          id: "automatic",
          status: "queued",
          userMessageId: "message-automatic",
          ordinal: 2,
          queuePosition: 1,
        },
        {
          id: "visible",
          status: "queued",
          userMessageId: "message-visible",
          ordinal: 3,
          queuePosition: 2,
        },
      ],
      messages: [
        {
          id: "provider-wake",
          text: "Model-facing text",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "Monitor updated",
          },
        },
        {
          id: "message-automatic",
          text: "A delegated task reached a terminal state.",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message-visible", text: "Visible queued message" },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["visible", "Visible queued message"],
    ]);
  });

  it("removes only the promoted head from the visible queue", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "promoted",
          status: "starting",
          userMessageId: "message-promoted",
          providerThreadId: "provider-thread",
          ordinal: 2,
          queuePosition: null,
        },
        {
          id: "still-queued",
          status: "queued",
          userMessageId: "message-still-queued",
          providerThreadId: "provider-thread",
          ordinal: 3,
          queuePosition: 2,
        },
      ],
      messages: [
        { id: "message-promoted", text: "Run now" },
        { id: "message-still-queued", text: "Wait longer" },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    expect(state.activeRun?.id).toBe("promoted");
    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["still-queued", "Wait longer"],
    ]);
  });

  it.each(["preparing", "starting", "waiting"] as const)(
    "does not promote queued work into a %s run",
    (status) => {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: "provider-thread" },
        runs: [
          {
            id: "active",
            status,
            providerThreadId: "provider-thread",
            activeAttemptId: "attempt-active",
            ordinal: 1,
          },
          { id: "queued", status: "queued", userMessageId: "message", ordinal: 2 },
        ],
        messages: [{ id: "message", text: "Queued" }],
        providerTurns: [
          {
            id: "provider-turn-active",
            runAttemptId: "attempt-active",
            status: status === "waiting" ? "completed" : "starting",
          },
        ],
        providerThreads: [
          {
            id: "provider-thread",
            appThreadId: "thread",
            providerSessionId: "provider-session",
          },
        ],
        providerSessions: [
          {
            id: "provider-session",
            status: "running",
            capabilities: capabilities({ queued: true, steer: true }),
          },
        ],
      } as never);

      expect(state.canPromoteToSteer).toBe(false);
    },
  );

  it("does not promote queued work until the running provider turn is projected", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "active",
          status: "running",
          providerThreadId: "provider-thread",
          activeAttemptId: "attempt-active",
          ordinal: 1,
        },
        { id: "queued", status: "queued", userMessageId: "message", ordinal: 2 },
      ],
      messages: [{ id: "message", text: "Queued" }],
      providerTurns: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "running",
          capabilities: capabilities({ queued: true, steer: true }),
        },
      ],
    } as never);

    expect(state.canPromoteToSteer).toBe(false);
  });

  it("does not expose known unsupported queue or fork actions", () => {
    const projection = {
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [{ id: "queued", status: "queued", userMessageId: "message", ordinal: 1 }],
      messages: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "ready",
          capabilities: capabilities(),
        },
      ],
    } as never;
    const queue = deriveThreadQueueWorkflowState(projection);
    const projectedItem = {
      item: { type: "assistant_message", runId: "run", status: "completed" },
    } as never;

    expect(queue.canReorder).toBe(false);
    expect(queue.canPromoteToSteer).toBe(false);
    expect(canForkProjectedAssistantItem({ projectedItem, capabilities: capabilities() })).toBe(
      false,
    );
    expect(canDetachThreadProviderSession(projection)).toBe(true);
  });

  it("allows native, portable, and capability-unknown exact-run forks", () => {
    const projectedItem = {
      item: { type: "assistant_message", runId: "run", status: "completed" },
    } as never;

    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ nativeFork: true }),
      }),
    ).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ portableFork: true }),
      }),
    ).toBe(true);
    expect(canForkProjectedAssistantItem({ projectedItem })).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem: {
          item: { type: "assistant_message", runId: "run", status: "running" },
        } as never,
      }),
    ).toBe(false);
  });

  it("merges the newest provider-finished run while checkpoint capture is pending", () => {
    const projection = {
      runs: [
        { id: "newest-queued", status: "queued", ordinal: 3 },
        { id: "older-completed", status: "completed", ordinal: 1 },
        { id: "newest-finished", status: "waiting", ordinal: 2 },
      ],
    } as never;

    expect(resolveLatestMergeBackRun(projection)?.id).toBe("newest-finished");
  });

  it("does not let a stale completed run later in storage order hide the waiting checkpoint", () => {
    const projection = {
      runs: [
        { id: "newest-finished", status: "waiting", ordinal: 2 },
        { id: "older-completed", status: "completed", ordinal: 1 },
      ],
    } as never;

    expect(resolveLatestMergeBackRun(projection)?.id).toBe("newest-finished");
  });

  it.each(["preparing", "starting", "running"] as const)(
    "does not merge older history while a newer run is %s",
    (status) => {
      const projection = {
        runs: [
          { id: "older-completed", status: "completed", ordinal: 1 },
          { id: "newer-active", status, ordinal: 2 },
        ],
      } as never;

      expect(resolveLatestMergeBackRun(projection)).toBeNull();
    },
  );
});

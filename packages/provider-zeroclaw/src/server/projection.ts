// Pure mapping from a ZeroClaw session/update to T3 events.
// Text coalescing lives in the adapter; this function sees already-flushed text.
import {
  MessageId,
  NodeId,
  PlanId,
  ProviderSessionId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";

import type { SessionUpdate } from "./protocol.ts";
import { subagentCallFromToolCall, subagentOutcomeFromToolResult } from "./subagents.ts";

export const ZEROCLAW_PROVIDER = ProviderDriverKind.make("zeroclaw");

export const ZEROCLAW_CAPABILITIES: OrchestrationV2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "client-boundary" },
};

export interface ProjectionIdentity {
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2ProviderTurn["runAttemptId"] extends infer _ ? never : never;
  readonly nodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runIdValue: NonNullable<OrchestrationV2TurnItem["runId"]>;
}

export interface ProjectionState {
  readonly identity: {
    readonly threadId: ThreadId;
    readonly runId: NonNullable<OrchestrationV2TurnItem["runId"]>;
    readonly nodeId: NodeId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly ordinal: number;
  };
  readonly now: DateTime.Utc;
  /** Tool call id → turn item id, so a result updates the item the call opened. */
  readonly items: Map<string, TurnItemId>;
  readonly subagents: Map<string, { readonly id: NodeId; readonly childThreadId: ThreadId }>;
  nextOrdinal: number;
}

export interface ProjectedUpdate {
  readonly events: ReadonlyArray<ProviderAdapterV2Event>;
  readonly contextUsage?: { readonly usedTokens?: number; readonly maxTokens?: number };
}

const SHELL_TOOLS = new Set(["shell", "bash"]);

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value) ?? "";
}

function baseItem(state: ProjectionState, id: TurnItemId, nativeId: string) {
  return {
    id,
    threadId: state.identity.threadId,
    runId: state.identity.runId,
    nodeId: state.identity.nodeId,
    providerThreadId: state.identity.providerThreadId,
    providerTurnId: state.identity.providerTurnId,
    nativeItemRef: { driver: ZEROCLAW_PROVIDER, nativeId, strength: "strong" as const },
    parentItemId: null,
    ordinal: state.nextOrdinal,
    status: "running" as const,
    title: null,
    startedAt: state.now,
    completedAt: null,
    updatedAt: state.now,
  };
}

function itemId(state: ProjectionState, nativeId: string): TurnItemId {
  const existing = state.items.get(nativeId);
  if (existing !== undefined) return existing;
  const id = TurnItemId.make(`zc-item-${nativeId}`);
  state.items.set(nativeId, id);
  state.nextOrdinal += 1;
  return id;
}

/**
 * Map one decoded session/update to the events it produces. Unknown types
 * produce no events. Mutates `state.items` and `state.subagents` so a later
 * result can find the item its call opened.
 */
export function sessionUpdateToEvents(
  state: ProjectionState,
  update: SessionUpdate,
): ProjectedUpdate {
  const { identity } = state;
  switch (update.type) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (!("text" in update)) return { events: [] };
      const kind = update.type === "agent_message_chunk" ? "assistant" : "reasoning";
      const id = itemId(state, kind);
      const item: OrchestrationV2TurnItem =
        kind === "assistant"
          ? {
              ...baseItem(state, id, kind),
              type: "assistant_message",
              messageId: MessageId.make(`zc-msg-${identity.providerTurnId}`),
              text: update.text,
              streaming: true,
            }
          : {
              ...baseItem(state, id, kind),
              type: "reasoning",
              text: update.text,
              streaming: true,
            };
      return { events: [{ type: "turn_item.updated", driver: ZEROCLAW_PROVIDER, turnItem: item }] };
    }
    case "tool_call": {
      if (!("toolCallId" in update)) return { events: [] };
      const id = itemId(state, update.toolCallId);
      const shell = SHELL_TOOLS.has(update.name);
      const item: OrchestrationV2TurnItem = shell
        ? {
            ...baseItem(state, id, update.toolCallId),
            title: update.name,
            type: "command_execution",
            input: textOf(update.input),
          }
        : {
            ...baseItem(state, id, update.toolCallId),
            title: update.name,
            type: "dynamic_tool",
            toolName: update.name,
            input: update.input ?? {},
          };
      const events: ProviderAdapterV2Event[] = [
        { type: "turn_item.updated", driver: ZEROCLAW_PROVIDER, turnItem: item },
      ];
      const call = subagentCallFromToolCall(update.name, update.input);
      if (call !== null) {
        const subagentId = NodeId.make(`zc-subagent-${update.toolCallId}`);
        const childThreadId = ThreadId.make(`zc-child-${update.toolCallId}`);
        state.subagents.set(update.toolCallId, { id: subagentId, childThreadId });
        events.push({
          type: "subagent.updated",
          driver: ZEROCLAW_PROVIDER,
          subagent: {
            id: subagentId,
            threadId: identity.threadId,
            runId: identity.runId,
            parentNodeId: identity.nodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: ZEROCLAW_PROVIDER,
            providerInstanceId: identity.providerInstanceId,
            providerThreadId: identity.providerThreadId,
            childThreadId,
            nativeTaskRef: {
              driver: ZEROCLAW_PROVIDER,
              nativeId: update.toolCallId,
              strength: "strong",
            },
            prompt: call.prompt,
            title: call.title,
            model: null,
            status: "running",
            result: null,
            startedAt: state.now,
            completedAt: null,
            updatedAt: state.now,
          },
        });
      }
      return { events };
    }
    case "tool_result": {
      if (!("toolCallId" in update)) return { events: [] };
      const id = state.items.get(update.toolCallId) ?? itemId(state, update.toolCallId);
      const failed = update.status === "failed";
      const output = textOf(update.output);
      const item: OrchestrationV2TurnItem = {
        ...baseItem(state, id, update.toolCallId),
        ordinal: state.items.has(update.toolCallId) ? state.nextOrdinal - 1 : state.nextOrdinal,
        status: failed ? "failed" : "completed",
        completedAt: state.now,
        type: "dynamic_tool",
        toolName: update.toolCallId,
        input: {},
        ...(output.length > 0 ? { output } : {}),
      };
      const events: ProviderAdapterV2Event[] = [
        { type: "turn_item.updated", driver: ZEROCLAW_PROVIDER, turnItem: item },
      ];
      const subagent = state.subagents.get(update.toolCallId);
      if (subagent !== undefined) {
        const outcome = subagentOutcomeFromToolResult(update.output);
        events.push({
          type: "subagent.updated",
          driver: ZEROCLAW_PROVIDER,
          subagent: {
            id: subagent.id,
            threadId: identity.threadId,
            runId: identity.runId,
            parentNodeId: identity.nodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: ZEROCLAW_PROVIDER,
            providerInstanceId: identity.providerInstanceId,
            providerThreadId: identity.providerThreadId,
            childThreadId: subagent.childThreadId,
            nativeTaskRef: {
              driver: ZEROCLAW_PROVIDER,
              nativeId: update.toolCallId,
              strength: "strong",
            },
            prompt: "",
            title: null,
            model: null,
            status: outcome.status,
            result: outcome.result,
            startedAt: state.now,
            completedAt: state.now,
            updatedAt: state.now,
            promptOmitted: true,
          },
        });
      }
      return { events };
    }
    case "approval_request": {
      if (!("requestId" in update)) return { events: [] };
      const requestId = RuntimeRequestId.make(update.requestId);
      const id = itemId(state, update.requestId);
      return {
        events: [
          {
            type: "turn_item.updated",
            driver: ZEROCLAW_PROVIDER,
            turnItem: {
              ...baseItem(state, id, update.requestId),
              status: "waiting",
              title: update.toolName,
              type: "approval_request",
              requestId,
              requestKind: "command",
              ...(update.argumentsSummary === undefined ? {} : { prompt: update.argumentsSummary }),
            },
          },
          {
            type: "runtime_request.updated",
            driver: ZEROCLAW_PROVIDER,
            threadId: identity.threadId,
            runtimeRequest: {
              id: requestId,
              nodeId: identity.nodeId,
              providerTurnId: identity.providerTurnId,
              nativeRequestRef: {
                driver: ZEROCLAW_PROVIDER,
                nativeId: update.requestId,
                strength: "strong",
              },
              kind: "command",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: ProviderSessionId.make(identity.providerThreadId),
              },
              createdAt: state.now,
              resolvedAt: null,
            },
          },
        ],
      };
    }
    case "plan":
      if (!("items" in update)) return { events: [] };
      return {
        events: [
          {
            type: "turn_item.updated",
            driver: ZEROCLAW_PROVIDER,
            turnItem: {
              ...baseItem(state, itemId(state, "plan"), "plan"),
              status: "completed",
              completedAt: state.now,
              type: "todo_list",
              planId: PlanId.make(`zc-plan-${identity.providerTurnId}`),
              steps: update.items.map((step, index) => ({
                id: `step-${index}`,
                text: step.content,
                status:
                  step.status === "completed" || step.status === "running"
                    ? step.status
                    : "pending",
              })),
            },
          },
        ],
      };
    case "context_usage":
      return {
        events: [],
        contextUsage: {
          ...("usedTokens" in update && update.usedTokens !== undefined
            ? { usedTokens: update.usedTokens }
            : {}),
          ...("maxTokens" in update && update.maxTokens !== undefined
            ? { maxTokens: update.maxTokens }
            : {}),
        },
      };
    case "history_trimmed":
    case "budget_warning": {
      const notice = update as { readonly type: string; readonly message?: string };
      return {
        events: [
          {
            type: "turn_item.updated",
            driver: ZEROCLAW_PROVIDER,
            turnItem: {
              ...baseItem(state, itemId(state, notice.type), notice.type),
              status: "completed",
              completedAt: state.now,
              type: "system_notice",
              message: notice.message ?? notice.type,
            },
          },
        ],
      };
    }
    case "turn_complete":
      if (!("outcome" in update)) return { events: [] };
      return {
        events: [
          update.outcome === "failed"
            ? {
                type: "turn.terminal",
                driver: ZEROCLAW_PROVIDER,
                providerThreadId: identity.providerThreadId,
                providerTurnId: identity.providerTurnId,
                runOrdinal: identity.ordinal,
                failureItemOrdinal: identity.ordinal,
                status: "failed",
                failure: {
                  class: "provider_error",
                  message: update.error ?? "ZeroClaw turn failed.",
                  code: null,
                  retryable: null,
                },
                threadDisposition: "reusable",
              }
            : {
                type: "turn.terminal",
                driver: ZEROCLAW_PROVIDER,
                providerThreadId: identity.providerThreadId,
                providerTurnId: identity.providerTurnId,
                runOrdinal: identity.ordinal,
                status: update.outcome === "cancelled" ? "cancelled" : "completed",
                failure: null,
                threadDisposition: "reusable",
              },
        ],
      };
    default:
      return { events: [] };
  }
}

/** Map a T3 approval decision to the ZeroClaw decision the daemon accepts. */
export function approvalDecisionToZeroClaw(
  decision: ProviderApprovalDecision,
): "allow_once" | "allow_always" | "reject" {
  switch (decision) {
    case "accept":
      return "allow_once";
    case "acceptForSession":
    case "acceptAlways":
      return "allow_always";
    default:
      return "reject";
  }
}

/** Split a `provider/model` slug. `default` and a slug with no slash return null. */
export function splitModelSlug(slug: string): { model: string; modelProvider: string } | null {
  if (slug === "default") return null;
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  return { modelProvider: slug.slice(0, separator), model: slug.slice(separator + 1) };
}

export const AGENT_MISMATCH_MESSAGE = (current: string, requested: string) =>
  `This thread runs agent \`${current}\`. Start a new thread to use agent \`${requested}\`.`;

export const DEFAULT_RESTORE_MESSAGE = (model: string) =>
  `This thread already switched to \`${model}\`. ZeroClaw cannot restore the agent default in a live session. Start a new thread to use the agent's configured model.`;

export const NO_AGENT_MESSAGE =
  "No ZeroClaw agent is selected. Set a default agent in provider settings (defaultAgentAlias) or choose one for this thread.";

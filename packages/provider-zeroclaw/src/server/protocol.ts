// Lenient decoders for the ZeroClaw RPC subset this adapter uses.
// Unknown session/update types decode as a catch-all rather than failing the turn.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const LooseRecord = Schema.Record(Schema.String, Schema.Unknown);

export const InitializeResult = Schema.Struct({
  protocolVersion: Schema.Number,
  serverInfo: Schema.optional(LooseRecord),
});
export type InitializeResult = typeof InitializeResult.Type;

export const StatusResult = Schema.Struct({
  version: Schema.optional(Schema.String),
  uptimeSecs: Schema.optional(Schema.Number),
});
export type StatusResult = typeof StatusResult.Type;

export const AgentInfo = Schema.Struct({
  alias: Schema.String,
  name: Schema.optional(Schema.String),
});
export type AgentInfo = typeof AgentInfo.Type;

export const AgentsListResult = Schema.Struct({
  agents: Schema.Array(AgentInfo),
});
export type AgentsListResult = typeof AgentsListResult.Type;

export const SessionNewResult = Schema.Struct({
  sessionId: Schema.String,
  agentAlias: Schema.optional(Schema.String),
});
export type SessionNewResult = typeof SessionNewResult.Type;

export const SessionPromptResult = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
});
export type SessionPromptResult = typeof SessionPromptResult.Type;

export const SessionStateResult = Schema.Struct({
  sessionId: Schema.String,
  agentAlias: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
});
export type SessionStateResult = typeof SessionStateResult.Type;

export const ConversationMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.String),
});
export type ConversationMessage = typeof ConversationMessage.Type;

export const SessionMessagesResult = Schema.Struct({
  messages: Schema.Array(ConversationMessage),
});
export type SessionMessagesResult = typeof SessionMessagesResult.Type;

export const SessionOverrides = Schema.Struct({
  model: Schema.optional(Schema.String),
  modelProvider: Schema.optional(Schema.String),
  temperature: Schema.optional(Schema.Number),
});
export type SessionOverrides = typeof SessionOverrides.Type;

export const ApprovalRequestUpdate = Schema.Struct({
  type: Schema.Literal("approval_request"),
  sessionId: Schema.optional(Schema.String),
  requestId: Schema.String,
  toolName: Schema.String,
  argumentsSummary: Schema.optional(Schema.String),
  timeoutSecs: Schema.optional(Schema.Number),
});
export type ApprovalRequestUpdate = typeof ApprovalRequestUpdate.Type;

export const TurnCompleteUpdate = Schema.Struct({
  type: Schema.Literal("turn_complete"),
  sessionId: Schema.optional(Schema.String),
  outcome: Schema.Literals(["completed", "cancelled", "failed"]),
  error: Schema.optional(Schema.String),
});
export type TurnCompleteUpdate = typeof TurnCompleteUpdate.Type;

const TextChunkUpdate = Schema.Struct({
  type: Schema.Literals(["agent_message_chunk", "agent_thought_chunk"]),
  sessionId: Schema.optional(Schema.String),
  text: Schema.String,
});

const ToolCallUpdate = Schema.Struct({
  type: Schema.Literal("tool_call"),
  sessionId: Schema.optional(Schema.String),
  toolCallId: Schema.String,
  name: Schema.String,
  input: Schema.optional(Schema.Unknown),
});

const ToolResultUpdate = Schema.Struct({
  type: Schema.Literal("tool_result"),
  sessionId: Schema.optional(Schema.String),
  toolCallId: Schema.String,
  status: Schema.optional(Schema.Literals(["completed", "failed"])),
  output: Schema.optional(Schema.Unknown),
});

const PlanUpdate = Schema.Struct({
  type: Schema.Literal("plan"),
  sessionId: Schema.optional(Schema.String),
  items: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      status: Schema.optional(Schema.String),
    }),
  ),
});

const ContextUsageUpdate = Schema.Struct({
  type: Schema.Literal("context_usage"),
  sessionId: Schema.optional(Schema.String),
  usedTokens: Schema.optional(Schema.Number),
  maxTokens: Schema.optional(Schema.Number),
});

const NoticeUpdate = Schema.Struct({
  type: Schema.Literals(["history_trimmed", "budget_warning"]),
  sessionId: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

/** Catch-all so a daemon that adds an update type does not fail the turn. */
const UnknownSessionUpdate = Schema.Struct({
  type: Schema.String,
  sessionId: Schema.optional(Schema.String),
});

const KnownSessionUpdate = Schema.Union([
  TextChunkUpdate,
  ToolCallUpdate,
  ToolResultUpdate,
  ApprovalRequestUpdate,
  PlanUpdate,
  ContextUsageUpdate,
  NoticeUpdate,
  TurnCompleteUpdate,
]);

const KNOWN_UPDATE_TYPES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_result",
  "approval_request",
  "plan",
  "context_usage",
  "history_trimmed",
  "budget_warning",
  "turn_complete",
]);

export const SessionUpdate = Schema.Union([KnownSessionUpdate, UnknownSessionUpdate]);
export type SessionUpdate = typeof SessionUpdate.Type;

const decodeKnownSessionUpdate = Schema.decodeUnknownEffect(KnownSessionUpdate);
const decodeUnknownSessionUpdate = Schema.decodeUnknownEffect(UnknownSessionUpdate);

/**
 * Known update types decode strictly. Anything else becomes the catch-all so a
 * daemon that adds a type does not fail the turn, while a malformed known type
 * still fails instead of being silently ignored.
 */
export const decodeSessionUpdate = (input: unknown) => {
  const type =
    typeof input === "object" && input !== null && "type" in input
      ? (input as { type?: unknown }).type
      : undefined;
  if (typeof type === "string" && !KNOWN_UPDATE_TYPES.has(type)) {
    return decodeUnknownSessionUpdate(input);
  }
  return decodeKnownSessionUpdate(input);
};

export const decodeInitializeResult = Schema.decodeUnknownEffect(InitializeResult);
export const decodeStatusResult = Schema.decodeUnknownEffect(StatusResult);
export const decodeAgentsListResult = Schema.decodeUnknownEffect(AgentsListResult);
export const decodeSessionNewResult = Schema.decodeUnknownEffect(SessionNewResult);
export const decodeSessionPromptResult = Schema.decodeUnknownEffect(SessionPromptResult);
export const decodeSessionStateResult = Schema.decodeUnknownEffect(SessionStateResult);
export const decodeSessionMessagesResult = Schema.decodeUnknownEffect(SessionMessagesResult);
export const decodeSessionUpdateSync = (input: unknown) =>
  Effect.runSync(decodeSessionUpdate(input));

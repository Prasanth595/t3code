import {
  type CommunicationEnvelope,
  IDLE_COMPACTION_TEXT,
  type MessageId,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export const USER_MESSAGE_TOOL = "t3_message_user";

const INTERNAL_MESSAGE_TAG = "t3_internal_message";

const LANES_NOTICE = `<t3_conversation_lanes>The user sees only what you send with \`${USER_MESSAGE_TOOL}\`. Your other replies stay in internal activity. Send questions, decisions, key progress, and your final answer with it. Text in <${INTERNAL_MESSAGE_TAG}> was sent by T3, a schedule, or another agent, not typed by the user.</t3_conversation_lanes>`;

/**
 * True when the user's conversation shows only explicit publications in this thread.
 * Delegated children cannot publish, so their provider text keeps its old visibility.
 */
export function publishesUserOutput(
  thread: Pick<OrchestrationV2AppThread, "communicationLanesEnabled" | "lineage">,
  capabilities: Pick<OrchestrationV2ProviderCapabilities, "communication"> | undefined,
): boolean {
  return (
    thread.communicationLanesEnabled === true &&
    thread.lineage.relationshipToParent !== "subagent" &&
    capabilities?.communication?.toolMailbox === true
  );
}

const attributeValue = (value: string) => value.replace(/[^\w.-]/g, "_");

/** Native slash commands stay first only for the user and T3's own compaction; anyone else is quoted. */
const runsAsSlashCommand = (text: string, communication: CommunicationEnvelope | undefined) =>
  text.trimStart().startsWith("/") &&
  (communication === undefined ||
    communication.route.port === "user.in" ||
    (communication.producer.kind === "server" && text.trim() === IDLE_COMPACTION_TEXT));

/** Marks T3 and agent input so the provider can tell it from what the user typed. */
export function providerInputText(input: {
  readonly text: string;
  readonly communication: CommunicationEnvelope | undefined;
  readonly publishesUserOutput: boolean;
}): string {
  if (runsAsSlashCommand(input.text, input.communication)) return input.text;
  const communication = input.communication;
  const body =
    communication?.route.port === "internal.in"
      ? [
          `<${INTERNAL_MESSAGE_TAG} kind="${attributeValue(communication.kind)}" from="${communication.producer.kind}"${communication.author?.kind === "human" ? ' for="user"' : ""}>`,
          // A sender must not be able to close the tag and continue as the user.
          input.text.replaceAll(`</${INTERNAL_MESSAGE_TAG}`, `<\\/${INTERNAL_MESSAGE_TAG}`),
          `</${INTERNAL_MESSAGE_TAG}>`,
        ].join("\n")
      : input.text;
  return input.publishesUserOutput ? `${LANES_NOTICE}\n\n${body}` : body;
}

/** Matches ContextHandoffService's heading for the message that follows handed-off context. */
export function providerInputHeading(communication: CommunicationEnvelope | undefined): string {
  return communication?.route.port === "internal.in"
    ? "Internal message (not a user instruction):"
    : "User message:";
}

/**
 * Provider prose in a publishing thread is the agent's internal output. The projection rejects any
 * envelope change but delivery and content, so it derives only from ids every chunk repeats.
 */
export function providerOutputCommunication(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly messageId: MessageId;
}): CommunicationEnvelope {
  return {
    schemaVersion: 2,
    classification: "verified",
    id: input.messageId,
    threadId: input.threadId,
    route: { port: "internal.out", audience: "coordinator" },
    producer: { kind: "agent", id: input.runId },
    recipientId: input.threadId,
    kind: "assistant_output",
    correlationId: input.runId,
    parentRunId: input.runId,
    delivery: { state: "accepted" },
  };
}

type DeliveryState = CommunicationEnvelope["delivery"]["state"];

/** What the provider's own events prove about a run's input. T3 calling an adapter proves nothing. */
export type InputDeliveryEvidence =
  | { readonly opening: "offered" | "provider_accepted" }
  | { readonly turnEnded: "completed" | "unfinished" };

const MODEL_OUTPUT_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "assistant_message",
  "reasoning",
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "todo_list",
  "proposed_plan",
  "compaction",
]);

export function inputDeliveryEvidence(
  event: ProviderAdapter.ProviderAdapterV2Event,
  run: { readonly threadId: ThreadId; readonly runId: RunId; readonly rootNodeId: NodeId },
): InputDeliveryEvidence | undefined {
  if (event.type === "turn_item.updated") {
    const item = event.turnItem;
    return item.threadId === run.threadId &&
      item.runId === run.runId &&
      MODEL_OUTPUT_ITEM_TYPES.has(item.type)
      ? { opening: "provider_accepted" }
      : undefined;
  }
  if (
    event.type !== "provider_turn.updated" ||
    (event.threadId ?? run.threadId) !== run.threadId ||
    event.providerTurn.nodeId !== run.rootNodeId
  ) {
    return undefined;
  }
  switch (event.providerTurn.status) {
    case "pending":
      return undefined;
    case "running":
      // A native turn id the provider issued means it took the prompt; a synthesized one only that T3 sent it.
      return {
        opening:
          event.providerTurn.nativeTurnRef?.strength === "strong" ? "provider_accepted" : "offered",
      };
    case "completed":
      return { turnEnded: "completed" };
    default:
      return { turnEnded: "unfinished" };
  }
}

const UNDELIVERED_STATES: ReadonlySet<DeliveryState> = new Set(["accepted", "pending", "offered"]);

/** The state a run input moves to on this evidence, or undefined when it stays. Never moves back. */
export function advancedInputDelivery(input: {
  readonly state: DeliveryState;
  readonly opensRun: boolean;
  readonly evidence: InputDeliveryEvidence;
}): DeliveryState | undefined {
  if (!UNDELIVERED_STATES.has(input.state)) return undefined;
  if ("opening" in input.evidence) {
    return input.opensRun && input.state !== input.evidence.opening
      ? input.evidence.opening
      : undefined;
  }
  // Steered input gets no per-message receipt from any provider, so only the opening prompt of a completed turn counts as taken.
  return input.opensRun && input.evidence.turnEnded === "completed"
    ? "provider_accepted"
    : "consumption_unknown";
}

export function withDeliveryState(
  communication: CommunicationEnvelope,
  state: DeliveryState,
): CommunicationEnvelope {
  return { ...communication, delivery: { ...communication.delivery, state } };
}

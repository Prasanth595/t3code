import { turnItemIsWorkspacePreparation } from "./turnItemPresentation.ts";
import type {
  CommunicationEnvelope,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";

// Items a blocked run or the thread structure depends on; never moved out of the conversation.
const ALWAYS_VISIBLE_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "approval_request",
  "user_input_request",
  "secret_request",
  "error",
  "run_interrupt_request",
  "run_interrupt_result",
  "proposed_plan",
  "handoff",
  "fork",
  "thread_created",
]);

/**
 * In an enabled thread only an explicit user.in/user.out envelope, or a control item, belongs in
 * the human conversation. Everything else, unaddressed work rows included, is coordination.
 */
export function isCoordinationTurnItem(
  item: OrchestrationV2TurnItem,
  lanesEnabled: boolean,
): boolean {
  if (!lanesEnabled) return false;
  const port = item.communication?.route.port;
  if (port === "user.in" || port === "user.out") return false;
  return !ALWAYS_VISIBLE_TYPES.has(item.type);
}

export function coordinationTurnItems(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  lanesEnabled: boolean,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  return rows.filter(
    ({ item }) =>
      isCoordinationTurnItem(item, lanesEnabled) &&
      item.type !== "checkpoint" &&
      !turnItemIsWorkspacePreparation(item),
  );
}

function clip(text: string, max: number): string {
  const line = text.trim().replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/** One short line for the Coordination list; the full body comes from getTurnItem on demand. */
export function coordinationItemPreview(item: OrchestrationV2TurnItem): string {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return clip(item.text, 160);
    case "notification":
      return clip(item.summary, 160);
    case "command_execution":
      return clip(`$ ${item.input}`, 160);
    case "file_change":
      return clip(`Edited ${item.fileName}`, 160);
    case "file_search":
      return clip(`Searched files${item.pattern ? `: ${item.pattern}` : ""}`, 160);
    case "web_search":
      return clip(`Web search${item.patterns?.length ? `: ${item.patterns.join(", ")}` : ""}`, 160);
    case "dynamic_tool":
      return clip(`Tool: ${item.toolName ?? "unknown"}`, 160);
    case "subagent":
      return clip(`Subagent: ${item.title ?? item.prompt}`, 160);
    case "system_notice":
    case "run_interrupt_request":
    case "run_interrupt_result":
      return clip(item.message, 160);
    case "compaction":
      return clip(item.summary ? `Context compacted: ${item.summary}` : "Context compacted", 160);
    case "todo_list":
      return clip(item.explanation ?? `Plan with ${item.steps.length} steps`, 160);
    default:
      return clip(item.title ?? item.type.replaceAll("_", " "), 160);
  }
}

/** Full body for the expanded Coordination row. */
export function coordinationItemText(item: OrchestrationV2TurnItem): string {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "notification":
      return item.detail ?? item.summary;
    case "command_execution":
      return item.output ? `$ ${item.input}\n\n${item.output}` : `$ ${item.input}`;
    case "file_change":
      return item.diffStr ?? coordinationItemPreview(item);
    case "dynamic_tool":
      return item.output === undefined
        ? stringify(item.input)
        : `${stringify(item.input)}\n\n${stringify(item.output)}`;
    case "subagent":
      return item.result ? `${item.prompt}\n\n${item.result}` : item.prompt;
    default:
      return coordinationItemPreview(item);
  }
}

/** Header line for a Coordination row: where it was routed, what it is, who made it, how far it got. */
export function coordinationItemHeader(item: OrchestrationV2TurnItem): string {
  const { communication } = item;
  return [
    communication?.route.port ?? "unclassified",
    item.type.replaceAll("_", " "),
    communication?.producer.kind,
    communicationDeliveryLabel(communication?.delivery),
    communicationCorrelationLabel(communication),
  ]
    .filter((part) => part != null)
    .join(" · ");
}

/**
 * A completed run produced assistant output but published nothing to the user conversation.
 * Unaddressed output counts: a provider without a publish tool never labels its replies.
 */
export function runFinishedWithoutUserUpdate(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  runId: RunId | null | undefined,
  status: string | null | undefined,
): boolean {
  if (runId == null || status !== "completed") return false;
  let hasUnpublishedOutput = false;
  let latestHumanInput = -1;
  let latestPublishedOutput = -1;
  for (const [index, { item }] of rows.entries()) {
    const port = item.communication?.route.port;
    if (port === "user.in") latestHumanInput = index;
    if (port === "user.out") latestPublishedOutput = index;
    if (item.runId !== runId) continue;
    if (port === "user.out") return false;
    if (item.type === "notification" && port === "internal.out") {
      hasUnpublishedOutput = true;
      continue;
    }
    if (item.type !== "assistant_message") continue;
    if (port === "internal.out" || item.text.trim() !== "") hasUnpublishedOutput = true;
  }
  return hasUnpublishedOutput && latestPublishedOutput <= latestHumanInput;
}

export const FINISHED_WITHOUT_USER_UPDATE_NOTICE =
  "Agent finished without a user update. No message was published to the user conversation; the output is in Coordination.";

export function communicationDeliveryLabel(
  delivery: CommunicationEnvelope["delivery"] | undefined,
): string | null {
  switch (delivery?.state) {
    case "accepted":
      return "Accepted";
    case "pending":
      return "Pending delivery";
    case "offered":
      return "Offered to provider";
    case "provider_accepted":
      return "Provider accepted";
    case "consumption_unknown":
      return "Provider consumption unknown";
    case "consumed":
      return "Consumed";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Delivery failed";
    default:
      return null;
  }
}

/** Badge text for a human message: settled delivery needs no badge, only the in-between states. */
export function pendingDeliveryLabel(
  delivery: CommunicationEnvelope["delivery"] | undefined,
): string | null {
  return delivery?.state === "consumed" ? null : communicationDeliveryLabel(delivery);
}

/** Correlation shown on coordination rows so a user.out reply can be traced to its request. */
export function communicationCorrelationLabel(
  communication: CommunicationEnvelope | undefined,
): string | null {
  if (communication === undefined) return null;
  return communication.replyTo !== undefined
    ? `reply to ${communication.replyTo}`
    : communication.causationId !== undefined
      ? `caused by ${communication.causationId}`
      : null;
}

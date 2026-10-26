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

/** Plain-language row label for a message between agents; null for user-facing traffic. */
export function coordinationMessageLabel(
  communication: CommunicationEnvelope | undefined,
): string | null {
  switch (communication?.route.port) {
    case "internal.in":
      switch (communication.producer.kind) {
        case "agent":
          return "Message from agent";
        case "scheduler":
          return "Message from scheduled task";
        case "monitor":
          return "Message from monitor";
        default:
          return "Message from T3 Code";
      }
    case "internal.out":
      switch (communication.route.audience) {
        case "agent":
          return "Message to agent";
        case "program":
          return "Message to program";
        default:
          return "Agent note";
      }
    default:
      return null;
  }
}

// Servers send this summary when an internal message has no text preview.
const COORDINATION_FALLBACK_SUMMARY = "Coordination activity";

/** Row label for coordination traffic: who it was between, then the message's first line. */
export function coordinationRowLabel(item: OrchestrationV2TurnItem): string | null {
  const isMessage = item.type === "user_message" || item.type === "assistant_message";
  // An unaddressed message in an enabled thread is the agent's own unpublished output.
  const label = coordinationMessageLabel(item.communication) ?? (isMessage ? "Agent note" : null);
  if (label === null) return null;
  const preview =
    item.type === "notification"
      ? item.summary
      : isMessage
        ? item.text.trim().split(/\r?\n/u, 1)[0]
        : undefined;
  return preview && preview !== COORDINATION_FALLBACK_SUMMARY ? `${label}: ${preview}` : label;
}

/** A coordination message with no text; feeds drop it like an empty assistant message. */
export function isEmptyCoordinationMessage(item: OrchestrationV2TurnItem): boolean {
  if (item.type === "notification") {
    return coordinationMessageLabel(item.communication) !== null && item.detail?.trim() === "";
  }
  return (
    (item.type === "user_message" || item.type === "assistant_message") &&
    item.text.trim() === "" &&
    (item.attachments?.length ?? 0) === 0
  );
}

/**
 * The live wire carries internal messages as text-free notifications; the full turn item fetched
 * on expand is a message, so fold its text into the notification the row already renders.
 */
export function coordinationNotificationWithDetail(
  wireItem: OrchestrationV2TurnItem,
  fetchedItem: OrchestrationV2TurnItem | null | undefined,
): OrchestrationV2TurnItem | null {
  if (
    wireItem.type !== "notification" ||
    coordinationMessageLabel(wireItem.communication) === null ||
    (fetchedItem?.type !== "user_message" && fetchedItem?.type !== "assistant_message")
  ) {
    return null;
  }
  return { ...wireItem, detail: fetchedItem.text };
}

/** A coordination notification whose text must be fetched before it can be shown. */
export function coordinationNotificationNeedsDetail(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "notification" &&
    item.detail === undefined &&
    coordinationMessageLabel(item.communication) !== null
  );
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
  "The agent finished without replying here. Its notes are in the work log above.";

/** Badge for a human message; only states the user may need to act on or wait for get one. */
export function pendingDeliveryLabel(
  delivery: CommunicationEnvelope["delivery"] | undefined,
): string | null {
  switch (delivery?.state) {
    case "pending":
      return "Waiting to send";
    case "offered":
      return "Sending";
    case "cancelled":
      return "Not sent";
    case "failed":
      return "Failed to send";
    default:
      return null;
  }
}

import type { OrchestrationV2ConversationMessage, OrchestrationV2Run } from "@t3tools/contracts";

/** Only a server-verified human ingress earns the human delivery position. */
export function communicationDeliveryPriority(
  message: Pick<OrchestrationV2ConversationMessage, "communication"> | undefined,
): number {
  return message?.communication?.classification === "verified" &&
    message.communication.route.port === "user.in" &&
    message.communication.producer.kind === "human"
    ? 0
    : 1;
}

export function hasQueuedHumanInput(projection: {
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
}): boolean {
  const humanMessageIds = new Set(
    projection.messages
      .filter((message) => communicationDeliveryPriority(message) === 0)
      .map((message) => message.id),
  );
  return projection.runs.some(
    (run) => run.status === "queued" && humanMessageIds.has(run.userMessageId),
  );
}

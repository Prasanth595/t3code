import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { communicationDeliveryPriority } from "./CommunicationScheduler.ts";

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages"> &
    Partial<Pick<OrchestrationV2ThreadProjection, "thread">>,
): ReadonlyArray<OrchestrationV2Run> {
  const messages = new Map(projection.messages.map((message) => [message.id, message]));
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      if (projection.thread?.communicationLanesEnabled === true) {
        const deliveryPriority =
          communicationDeliveryPriority(messages.get(left.userMessageId)) -
          communicationDeliveryPriority(messages.get(right.userMessageId));
        if (deliveryPriority !== 0) return deliveryPriority;
      } else {
        const deliveryPriority =
          Number(automaticCompletionMessageIds.has(right.userMessageId)) -
          Number(automaticCompletionMessageIds.has(left.userMessageId));
        if (deliveryPriority !== 0) return deliveryPriority;
      }
      return (
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
}

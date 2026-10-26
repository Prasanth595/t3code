import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import { communicationDeliveryPriority } from "./CommunicationScheduler.ts";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

export const COMMUNICATION_LANES_PAUSE_ENV = "T3_COMMUNICATION_LANES_PAUSED";

/** A restart-scoped operating switch. Existing envelopes and queued runs stay intact. */
export function communicationLanesPaused(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = environment[COMMUNICATION_LANES_PAUSE_ENV]?.toLowerCase();
  return value === "1" || value === "true";
}

export function isPausedInternalQueuedRun(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "messages">,
  run: OrchestrationV2Run,
  paused: boolean,
): boolean {
  if (!paused || projection.thread.communicationLanesEnabled !== true) return false;
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  return communicationDeliveryPriority(message) !== 0;
}

/** Metadata-only diagnostic page. Text and attachments never enter this result. */
export function communicationDiagnostics(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
  paused: boolean,
  cursor = 0,
  limit = 100,
) {
  const messages = new Map(projection.messages.map((message) => [message.id, message]));
  const queued = queuedRunsInDeliveryOrder(projection);
  const queuedUserRuns = queued.filter(
    (run) => communicationDeliveryPriority(messages.get(run.userMessageId)) === 0,
  ).length;
  const inputMessages = projection.messages.filter(
    (message) =>
      message.communication?.route.port === "user.in" ||
      message.communication?.route.port === "internal.in",
  );
  return {
    threadId: projection.thread.id,
    enabled: projection.thread.communicationLanesEnabled === true,
    internalDeliveryPaused: paused && projection.thread.communicationLanesEnabled === true,
    queuedUserRuns,
    queuedInternalRuns: queued.length - queuedUserRuns,
    acceptedInputs: inputMessages.filter(
      (message) => message.communication?.delivery.state === "accepted",
    ).length,
    offeredInputs: inputMessages.filter(
      (message) => message.communication?.delivery.state === "offered",
    ).length,
    providerAcceptedInputs: inputMessages.filter(
      (message) => message.communication?.delivery.state === "provider_accepted",
    ).length,
    consumptionUnknownInputs: inputMessages.filter(
      (message) => message.communication?.delivery.state === "consumption_unknown",
    ).length,
    publishedUserOutputs: projection.messages.filter(
      (message) => message.communication?.route.port === "user.out",
    ).length,
    internalOutputs: projection.messages.filter(
      (message) => message.communication?.route.port === "internal.out",
    ).length,
    pending: queued.slice(cursor, cursor + limit).map((run) => {
      const message = messages.get(run.userMessageId);
      return {
        runId: run.id,
        messageId: run.userMessageId,
        port: message?.communication?.route.port ?? "unclassified",
        deliveryState: message?.communication?.delivery.state ?? "unknown",
      };
    }),
    nextCursor: cursor + limit < queued.length ? cursor + limit : null,
  };
}

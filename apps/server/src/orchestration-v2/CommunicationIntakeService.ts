import type {
  CommandId,
  CommunicationEnvelope,
  MessageId,
  NodeId,
  OrchestrationV2Command,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

type Dispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

/** This is called only after the transport has bound creation provenance to its caller. */
export function communicationForDispatch(
  command: Dispatch,
  existingCommunication?: CommunicationEnvelope,
): CommunicationEnvelope {
  // A steer that finishes between delivery and acknowledgement is retried with the same
  // message id and a new command id. Its verified provenance must remain immutable.
  if (existingCommunication !== undefined) return existingCommunication;
  // runtime-request.respond has already authenticated the user's answer before creating this id.
  const answeredRuntimeRequest =
    command.createdBy === "user" &&
    command.creationSource === "server" &&
    command.messageId.startsWith("async-answer:");
  const interactive =
    command.createdBy === "user" &&
    (command.creationSource === "web" ||
      command.creationSource === "mobile" ||
      answeredRuntimeRequest) &&
    command.scheduledTaskId === undefined &&
    command.senderThreadId === undefined &&
    command.notification === undefined &&
    command.delegatedCompletion === undefined &&
    command.idleCompaction === undefined &&
    command.restartContinuationOfRunId === undefined &&
    command.usageLimitContinuationOfRunId === undefined;

  const producer = interactive
    ? { kind: "human" as const, id: "interactive-user" }
    : command.scheduledTaskId !== undefined
      ? { kind: "scheduler" as const, id: command.scheduledTaskId }
      : command.senderThreadId !== undefined
        ? { kind: "agent" as const, id: command.senderThreadId }
        : command.notification?.source.kind === "monitor"
          ? { kind: "monitor" as const, id: command.threadId }
          : command.creationSource === "provider"
            ? { kind: "provider" as const, id: command.threadId }
            : { kind: "server" as const, id: command.threadId };

  return {
    schemaVersion: 2,
    classification: "verified",
    id: command.messageId,
    threadId: command.threadId,
    route: interactive
      ? { port: "user.in", audience: "coordinator" }
      : { port: "internal.in", audience: "coordinator" },
    producer,
    ...(command.scheduledTaskId !== undefined && command.createdBy === "user"
      ? {
          authorizedBy: "interactive-user",
          author: { kind: "human" as const, id: "interactive-user" },
        }
      : {}),
    recipientId: command.threadId,
    kind: interactive
      ? answeredRuntimeRequest
        ? "user_reply"
        : "user_request"
      : command.delegatedCompletion !== undefined
        ? "delegation_result"
        : command.scheduledTaskId !== undefined
          ? "scheduled_trigger"
          : command.notification !== undefined
            ? "notification"
            : command.senderThreadId !== undefined
              ? "agent_message"
              : "maintenance",
    correlationId: command.delegatedCompletion?.parentRunId ?? command.commandId,
    ...(command.delegatedCompletion === undefined
      ? {}
      : { parentRunId: command.delegatedCompletion.parentRunId }),
    idempotencyKey: command.commandId,
    content: { artifactRefs: command.attachments.map((attachment) => attachment.id) },
    delivery: { state: "accepted" },
  };
}

export function communicationForUserOutput(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly runId: RunId;
  readonly runUserMessageId: MessageId;
  readonly replyTo?: MessageId;
  readonly replyCorrelationId?: string;
}): CommunicationEnvelope {
  return {
    schemaVersion: 2,
    classification: "verified",
    id: input.messageId,
    threadId: input.threadId,
    route: { port: "user.out", audience: "human" },
    producer: { kind: "agent", id: input.runId },
    recipientId: "human",
    kind: "user_progress",
    correlationId: input.replyCorrelationId ?? input.runUserMessageId,
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    parentRunId: input.runId,
    idempotencyKey: input.commandId,
    content: { artifactRefs: [] },
    delivery: { state: "accepted" },
  };
}

export function communicationForInternalOutput(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly runId: RunId;
  readonly recipientThreadId: ThreadId;
  readonly recipientMessageId: MessageId;
  readonly recipientTaskId?: NodeId | undefined;
}): CommunicationEnvelope {
  return {
    schemaVersion: 2,
    classification: "verified",
    id: input.messageId,
    threadId: input.threadId,
    route: { port: "internal.out", audience: "agent" },
    producer: { kind: "agent", id: input.runId },
    recipientId: input.recipientThreadId,
    kind: input.recipientTaskId === undefined ? "agent_message" : "delegation_request",
    correlationId: input.recipientMessageId,
    parentRunId: input.runId,
    ...(input.recipientTaskId === undefined ? {} : { taskId: input.recipientTaskId }),
    idempotencyKey: input.commandId,
    content: { artifactRefs: [] },
    delivery: { state: "accepted" },
  };
}

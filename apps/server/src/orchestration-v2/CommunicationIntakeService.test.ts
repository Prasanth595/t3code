import { describe, expect, it } from "vite-plus/test";

import {
  communicationForDispatch,
  communicationForInternalOutput,
  communicationForUserOutput,
} from "./CommunicationIntakeService.ts";

const humanMessage = {
  type: "message.dispatch",
  commandId: "command:human",
  threadId: "thread:parent",
  messageId: "message:human",
  text: "What changed?",
  attachments: [],
  createdBy: "user",
  creationSource: "web",
} as const;

describe("communication intake", () => {
  it("reserves user.in for interactive human sends", () => {
    const received = communicationForDispatch(humanMessage as never);
    expect(received.route).toEqual({ port: "user.in", audience: "coordinator" });
    expect(received.producer.kind).toBe("human");
    expect(received.delivery.state).toBe("accepted");
  });

  it("keeps a user-authored schedule on the internal lane", () => {
    const received = communicationForDispatch({
      ...humanMessage,
      scheduledTaskId: "schedule:daily",
    } as never);
    expect(received.route.port).toBe("internal.in");
    expect(received.producer.kind).toBe("scheduler");
    expect(received.author?.kind).toBe("human");
    expect(received.authorizedBy).toBe("interactive-user");
  });

  it("keeps a server-dispatched answer to an agent question on the human lane", () => {
    const received = communicationForDispatch({
      ...humanMessage,
      messageId: "async-answer:request-1",
      creationSource: "server",
    } as never);
    expect(received.route.port).toBe("user.in");
    expect(received.producer.kind).toBe("human");
    expect(received.kind).toBe("user_reply");
    const continuation = communicationForDispatch({
      ...humanMessage,
      messageId: "async-answer:request-1",
      creationSource: "server",
      usageLimitContinuationOfRunId: "run:prior",
    } as never);
    expect(continuation.route.port).toBe("internal.in");
  });

  it("keeps agent sends and delegated completions on the internal lane", () => {
    const agent = communicationForDispatch({
      ...humanMessage,
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: "thread:child",
    } as never);
    const completion = communicationForDispatch({
      ...humanMessage,
      createdBy: "agent",
      creationSource: "server",
      delegatedCompletion: {
        parentRunId: "run:parent",
        generation: 1,
        taskIds: ["node:child"],
      },
    } as never);
    expect(agent.route.port).toBe("internal.in");
    expect(agent.producer.kind).toBe("agent");
    expect(completion.route.port).toBe("internal.in");
    expect(completion.kind).toBe("delegation_result");
  });

  it("correlates explicit user output from an internally triggered run", () => {
    const output = communicationForUserOutput({
      commandId: "command:publish",
      threadId: "thread:parent",
      messageId: "message:published",
      runId: "run:internal-wake",
      runUserMessageId: "message:internal-wake",
      replyTo: "message:human",
      replyCorrelationId: "command:human",
    } as never);
    expect(output.route.port).toBe("user.out");
    expect(output.replyTo).toBe("message:human");
    expect(output.correlationId).toBe("command:human");
  });

  it("records the sender side of an agent message with the recipient message as correlation", () => {
    const output = communicationForInternalOutput({
      commandId: "command:sender",
      threadId: "thread:parent",
      messageId: "message:sender",
      runId: "run:parent",
      recipientThreadId: "thread:child",
      recipientMessageId: "message:child",
      recipientTaskId: "node:child",
    } as never);
    expect(output.route).toEqual({ port: "internal.out", audience: "agent" });
    expect(output.producer).toEqual({ kind: "agent", id: "run:parent" });
    expect(output.recipientId).toBe("thread:child");
    expect(output.correlationId).toBe("message:child");
    expect(output.taskId).toBe("node:child");
  });

  it("preserves the original envelope when a steered message becomes a follow-up", () => {
    const original = communicationForDispatch({
      ...humanMessage,
      commandId: "command:original",
      createdBy: "agent",
      creationSource: "server",
      senderThreadId: "thread:child",
    } as never);
    const followUp = communicationForDispatch(
      {
        ...humanMessage,
        commandId: "command:steer-follow-up:effect-1",
        createdBy: "agent",
        creationSource: "server",
        senderThreadId: "thread:child",
      } as never,
      original,
    );
    expect(followUp).toBe(original);
    expect(followUp.correlationId).toBe("command:original");
    expect(followUp.idempotencyKey).toBe("command:original");
  });
});

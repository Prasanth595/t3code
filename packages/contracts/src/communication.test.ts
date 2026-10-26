import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CommunicationEnvelope } from "./communication.ts";
import {
  OrchestrationV2Command,
  OrchestrationV2ConversationMessageJson,
} from "./orchestrationV2.ts";

const decodeMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson);
const encodeMessage = Schema.encodeSync(OrchestrationV2ConversationMessageJson);
const decodeEnvelope = Schema.decodeUnknownSync(CommunicationEnvelope);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);

const message = {
  id: "message-1",
  threadId: "thread-1",
  runId: null,
  nodeId: null,
  role: "user",
  text: "A result is ready",
  attachments: [],
  streaming: false,
  createdBy: "agent",
  creationSource: "server",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

const communication = {
  schemaVersion: 2,
  classification: "verified",
  id: "message-1",
  threadId: "thread-1",
  route: { port: "internal.in", audience: "coordinator" },
  producer: { kind: "agent", id: "agent-1" },
  recipientId: "thread-1",
  kind: "delegation.result",
  correlationId: "request-1",
  delivery: { state: "accepted" },
};

describe("communication contracts", () => {
  it("round-trips an internal route independently of the legacy user role", () => {
    const parsed = decodeMessage({ ...message, communication });
    expect(parsed.role).toBe("user");
    expect(parsed.communication?.route.port).toBe("internal.in");
    expect(encodeMessage(parsed).communication).toEqual(communication);
  });

  it("keeps old messages readable without granting a verified lane", () => {
    const parsed = decodeMessage(message);
    expect(parsed.communication).toBeUndefined();
  });

  it("rejects impossible routes and keeps output publication off the public command schema", () => {
    expect(() =>
      decodeEnvelope({
        ...communication,
        route: { port: "user.in", audience: "human" },
      }),
    ).toThrow();
    expect(() =>
      decodeCommand({
        type: "communication.publish-output",
        commandId: "command-1",
        threadId: "thread-1",
        messageId: "message-1",
        text: "Ready",
      }),
    ).toThrow();
  });
});

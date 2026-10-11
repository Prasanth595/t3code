import { describe, expect, it } from "@effect/vitest";
import {
  childSessionId,
  copilotPromptFailure,
  extractCopilotSubagentUpdate,
} from "./copilotAcp.ts";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

describe("copilotAcp", () => {
  it("formats child session IDs correctly", () => {
    expect(childSessionId("task-123")).toBe("copilot-task:task-123");
  });

  it("extracts subagent updates from task tool calls", () => {
    const toolCall: AcpToolCallState = {
      toolCallId: "call-1",
      title: "Explore codebase",
      kind: "other",
      status: "inProgress",
      data: {
        rawInput: {
          description: "Explore repo",
          prompt: "Find all usages of config.",
          agent_type: "explore",
          model: "gpt-4o",
          mode: "sync",
        },
        rawOutput: null,
      },
    };

    const update = extractCopilotSubagentUpdate(toolCall);
    expect(update).toBeDefined();
    expect(update?.nativeTaskId).toBe("call-1");
    expect(update?.childSessionId).toBe("copilot-task:call-1");
    expect(update?.prompt).toBe("Find all usages of config.");
    expect(update?.title).toBe("Explore repo");
    expect(update?.model).toBe("gpt-4o");
    expect(update?.status).toBe("running");
  });

  it("classifies rate limit and quota failures as usage_limit", () => {
    const rateLimitFailure = copilotPromptFailure(new Error("Rate limit exceeded for model"));
    expect(rateLimitFailure.class).toBe("usage_limit");
    expect(rateLimitFailure.retryable).toBe(true);

    const quotaFailure = copilotPromptFailure("Copilot plan quota exceeded");
    expect(quotaFailure.class).toBe("usage_limit");
    expect(quotaFailure.retryable).toBe(true);

    const genericFailure = copilotPromptFailure(new Error("Failed to connect to agent"));
    expect(genericFailure.class).toBe("provider_error");
    expect(genericFailure.retryable).toBe(false);
  });
});

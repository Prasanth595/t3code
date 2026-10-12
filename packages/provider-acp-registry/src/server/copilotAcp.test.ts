import { describe, expect, it } from "@effect/vitest";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

import { extractCopilotSubagentUpdate } from "./copilotAcp.ts";

const task = (agent_type: string): AcpToolCallState => ({
  toolCallId: "task-1",
  status: "pending",
  data: { rawInput: { agent_type, prompt: "do it" } },
});

describe("extractCopilotSubagentUpdate", () => {
  it("trims agent_type and drops a blank one", () => {
    expect(extractCopilotSubagentUpdate(task(" explore "))?.agentType).toBe("explore");
    expect(extractCopilotSubagentUpdate(task("  "))?.agentType).toBeUndefined();
  });
});

import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpUpdateScheduledTaskInput,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeScheduleTaskInput = Schema.decodeUnknownSync(OrchestratorMcpScheduleTaskInput);
const decodeUpdateScheduledTaskInput = Schema.decodeUnknownSync(
  OrchestratorMcpUpdateScheduledTaskInput,
);

describe("orchestrator MCP contracts", () => {
  it("accepts watcher setup and preserves omitted versus cleared watcher updates", () => {
    const watch = {
      source: {
        type: "jira",
        baseUrl: "https://example.atlassian.net",
        jql: "project = APP",
        auth: { type: "basic", username: "user@example.com", secretRef: "secret:request" },
      },
      filters: [{ path: "fields.status.name", op: "equals", value: "To Do" }],
      maxConcurrentRuns: 1,
    };
    expect(
      decodeScheduleTaskInput({
        prompt: "Handle the matching issue",
        schedule: { type: "interval", everyMs: 60_000 },
        watch,
      }).watch,
    ).toEqual(watch);
    expect(
      decodeUpdateScheduledTaskInput({ scheduledTaskId: "watch:1", enabled: false }),
    ).not.toHaveProperty("watch");
    expect(
      decodeUpdateScheduledTaskInput({ scheduledTaskId: "watch:1", watch: null }).watch,
    ).toBeNull();
    expect(decodeUpdateScheduledTaskInput({ scheduledTaskId: "watch:1", watch }).watch).toEqual(
      watch,
    );
  });

  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.pendingApproval).toBeNull();
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });
});

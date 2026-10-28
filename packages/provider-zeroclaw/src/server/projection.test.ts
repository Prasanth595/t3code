import {
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { decodeSessionUpdateSync } from "./protocol.ts";
import {
  AGENT_MISMATCH_MESSAGE,
  DEFAULT_RESTORE_MESSAGE,
  approvalDecisionToZeroClaw,
  sessionUpdateToEvents,
  splitModelSlug,
  type ProjectionState,
} from "./projection.ts";

function state(): ProjectionState {
  return {
    identity: {
      threadId: ThreadId.make("thread-1"),
      runId: RunId.make("run-1"),
      nodeId: NodeId.make("node-1"),
      providerThreadId: ProviderThreadId.make("pthread-1"),
      providerTurnId: ProviderTurnId.make("pturn-1"),
      providerInstanceId: ProviderInstanceId.make("instance-1"),
      ordinal: 1,
    },
    now: DateTime.makeUnsafe(0),
    items: new Map(),
    subagents: new Map(),
    nextOrdinal: 0,
  };
}

function project(input: unknown, current = state()) {
  return sessionUpdateToEvents(current, decodeSessionUpdateSync(input));
}

describe("sessionUpdateToEvents", () => {
  it("projects a message chunk as a streaming assistant item", () => {
    const projected = project({ type: "agent_message_chunk", text: "hello" });
    expect(projected.events[0]).toMatchObject({
      type: "turn_item.updated",
      turnItem: { type: "assistant_message", text: "hello", streaming: true },
    });
  });

  it("projects a thought chunk as streaming reasoning", () => {
    expect(project({ type: "agent_thought_chunk", text: "hmm" }).events[0]).toMatchObject({
      turnItem: { type: "reasoning", text: "hmm", streaming: true },
    });
  });

  it("projects a shell tool call as command execution and another tool as dynamic", () => {
    expect(
      project({ type: "tool_call", toolCallId: "c1", name: "shell", input: "ls" }).events[0],
    ).toMatchObject({
      turnItem: { type: "command_execution", input: "ls", status: "running" },
    });
    expect(
      project({ type: "tool_call", toolCallId: "c2", name: "read", input: { path: "a" } })
        .events[0],
    ).toMatchObject({
      turnItem: { type: "dynamic_tool", toolName: "read" },
    });
  });

  it("projects a tool result onto the item the call opened", () => {
    const current = state();
    project({ type: "tool_call", toolCallId: "c1", name: "read", input: {} }, current);
    const result = project(
      { type: "tool_result", toolCallId: "c1", status: "failed", output: "nope" },
      current,
    );
    expect(result.events[0]).toMatchObject({
      turnItem: { status: "failed", output: "nope" },
    });
  });

  it("projects an approval as a turn item and a live runtime request", () => {
    const projected = project({
      type: "approval_request",
      requestId: "r1",
      toolName: "shell",
      argumentsSummary: "rm -rf",
    });
    expect(projected.events.map((event) => event.type)).toEqual([
      "turn_item.updated",
      "runtime_request.updated",
    ]);
  });

  it("projects a plan as a todo list", () => {
    expect(
      project({ type: "plan", items: [{ content: "step", status: "running" }] }).events[0],
    ).toMatchObject({
      turnItem: { type: "todo_list", steps: [{ text: "step", status: "running" }] },
    });
  });

  it("projects context usage without an event", () => {
    expect(project({ type: "context_usage", usedTokens: 3, maxTokens: 9 })).toEqual({
      events: [],
      contextUsage: { usedTokens: 3, maxTokens: 9 },
    });
  });

  it("projects notices and a terminal outcome", () => {
    expect(project({ type: "history_trimmed", message: "trimmed" }).events[0]).toMatchObject({
      turnItem: { type: "system_notice", message: "trimmed" },
    });
    expect(project({ type: "budget_warning", message: "low" }).events[0]).toMatchObject({
      turnItem: { type: "system_notice" },
    });
    expect(project({ type: "turn_complete", outcome: "cancelled" }).events[0]).toMatchObject({
      type: "turn.terminal",
      status: "cancelled",
    });
    expect(
      project({ type: "turn_complete", outcome: "failed", error: "boom" }).events[0],
    ).toMatchObject({
      status: "failed",
      failure: { message: "boom" },
    });
  });

  it("ignores an unknown update type", () => {
    expect(project({ type: "future_event", sessionId: "s1" })).toEqual({ events: [] });
  });

  it("opens a subagent for a foreground spawn and settles it on the result", () => {
    const current = state();
    const opened = project(
      {
        type: "tool_call",
        toolCallId: "c1",
        name: "spawn_subagent",
        input: { prompt: "review", agent: "reviewer" },
      },
      current,
    );
    expect(opened.events.map((event) => event.type)).toEqual([
      "turn_item.updated",
      "subagent.updated",
    ]);
    const settled = project(
      { type: "tool_result", toolCallId: "c1", status: "completed", output: "looks good" },
      current,
    );
    expect(settled.events[1]).toMatchObject({
      type: "subagent.updated",
      subagent: { status: "completed", result: "looks good" },
    });
  });

  it("does not open a subagent for a background delegate", () => {
    const projected = project({
      type: "tool_call",
      toolCallId: "c1",
      name: "delegate",
      input: { action: "delegate", prompt: "look", background: true },
    });
    expect(projected.events.map((event) => event.type)).toEqual(["turn_item.updated"]);
  });
});

describe("model and approval helpers", () => {
  it("splits a slug and treats default as a sentinel", () => {
    expect(splitModelSlug("openai/gpt")).toEqual({ modelProvider: "openai", model: "gpt" });
    expect(splitModelSlug("default")).toBeNull();
    expect(splitModelSlug("noslash")).toBeNull();
  });

  it("maps approval decisions", () => {
    expect(approvalDecisionToZeroClaw("accept")).toBe("allow_once");
    expect(approvalDecisionToZeroClaw("acceptForSession")).toBe("allow_always");
    expect(approvalDecisionToZeroClaw("decline")).toBe("reject");
    expect(approvalDecisionToZeroClaw("cancel")).toBe("reject");
  });

  it("names the agent and the setting in its failure messages", () => {
    expect(AGENT_MISMATCH_MESSAGE("coder", "reviewer")).toContain("coder");
    expect(DEFAULT_RESTORE_MESSAGE("openai/gpt")).toContain("openai/gpt");
  });
});

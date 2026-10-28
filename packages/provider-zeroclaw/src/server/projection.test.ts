import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
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
      providerSessionId: ProviderSessionId.make("psession-1"),
      ordinal: 1,
    },
    now: DateTime.makeUnsafe(0),
    items: new Map(),
    tools: new Map(),
    subagents: new Map(),
    text: { assistant: "", reasoning: "" },
    nextOrdinal: 0,
  };
}

function project(input: unknown, current = state()) {
  return sessionUpdateToEvents(current, decodeSessionUpdateSync(input));
}

describe("sessionUpdateToEvents", () => {
  it("projects a message chunk as a streaming assistant item and its message", () => {
    const projected = project({ type: "agent_message_chunk", text: "hello" });
    expect(projected.events.map((event) => event.type)).toEqual([
      "turn_item.updated",
      "message.updated",
    ]);
    expect(projected.events[0]).toMatchObject({
      turnItem: { type: "assistant_message", text: "hello", streaming: true, status: "running" },
    });
    expect(projected.events[1]).toMatchObject({
      message: {
        role: "assistant",
        text: "hello",
        streaming: true,
        threadId: "thread-1",
        runId: "run-1",
      },
    });
  });

  it("accumulates chunks into one message row", () => {
    const current = state();
    project({ type: "agent_message_chunk", text: "he" }, current);
    const second = project({ type: "agent_message_chunk", text: "llo" }, current);
    expect(second.events[0]).toMatchObject({ turnItem: { text: "hello" } });
    expect(second.events[1]).toMatchObject({ message: { text: "hello" } });
    const ids = second.events.map((event) => JSON.stringify(event));
    expect(new Set(ids).size).toBe(2);
  });

  it("projects a thought chunk as streaming reasoning", () => {
    expect(project({ type: "agent_thought_chunk", text: "hmm" }).events[0]).toMatchObject({
      turnItem: { type: "reasoning", text: "hmm", streaming: true },
    });
  });

  it("settles the assistant text with the turn's final content", () => {
    const current = state();
    project({ type: "agent_message_chunk", text: "hel" }, current);
    const terminal = project(
      { type: "turn_complete", outcome: "completed", content: "hello there" },
      current,
    );
    expect(terminal.events.map((event) => event.type)).toEqual([
      "turn_item.updated",
      "message.updated",
      "turn.terminal",
    ]);
    expect(terminal.events[0]).toMatchObject({
      turnItem: { text: "hello there", streaming: false, status: "completed" },
    });
    expect(terminal.events[1]).toMatchObject({
      message: { text: "hello there", streaming: false },
    });
  });

  it("projects a shell tool call as command execution and another tool as dynamic", () => {
    expect(
      project({ type: "tool_call", tool_call_id: "c1", name: "shell", raw_input: "ls" }).events[0],
    ).toMatchObject({
      turnItem: { type: "command_execution", input: "ls", status: "running" },
    });
    expect(
      project({ type: "tool_call", tool_call_id: "c2", name: "read", raw_input: { path: "a" } })
        .events[0],
    ).toMatchObject({
      turnItem: { type: "dynamic_tool", toolName: "read" },
    });
  });

  it("keeps a result on the card its call opened", () => {
    const current = state();
    const opened = project(
      { type: "tool_call", tool_call_id: "c1", name: "read", raw_input: { path: "a" } },
      current,
    );
    const result = project(
      { type: "tool_result", tool_call_id: "c1", status: "failed", raw_output: "nope" },
      current,
    );
    expect(result.events[0]).toMatchObject({
      turnItem: {
        id: (opened.events[0] as { turnItem: { id: string } }).turnItem.id,
        status: "failed",
        output: "nope",
        type: "dynamic_tool",
        toolName: "read",
        input: { path: "a" },
      },
    });
  });

  it("keeps a shell result a command execution with its command line", () => {
    const current = state();
    project({ type: "tool_call", tool_call_id: "c1", name: "shell", raw_input: "ls -la" }, current);
    expect(
      project({ type: "tool_result", tool_call_id: "c1", raw_output: "a\nb" }, current).events[0],
    ).toMatchObject({
      turnItem: {
        type: "command_execution",
        title: "shell",
        input: "ls -la",
        output: "a\nb",
        status: "completed",
      },
    });
  });

  it("projects an approval as a turn item and a live runtime request", () => {
    const projected = project({
      type: "approval_request",
      request_id: "r1",
      tool_name: "shell",
      arguments_summary: "rm -rf",
    });
    expect(projected.events.map((event) => event.type)).toEqual([
      "turn_item.updated",
      "runtime_request.updated",
    ]);
    expect(projected.events[1]).toMatchObject({
      runtimeRequest: {
        responseCapability: { type: "live", providerSessionId: "psession-1" },
      },
    });
  });

  it("projects a plan as a todo list", () => {
    expect(
      project({ type: "plan", entries: [{ content: "step", status: "in_progress" }] }).events[0],
    ).toMatchObject({
      turnItem: { type: "todo_list", steps: [{ text: "step", status: "running" }] },
    });
  });

  it("projects context usage as turn token usage without an event", () => {
    expect(project({ type: "context_usage", input_tokens: 3, max_context_tokens: 9 })).toEqual({
      events: [],
      tokenUsage: { usedTokens: 3, maxTokens: 9 },
    });
  });

  it("projects notices and a terminal outcome", () => {
    expect(
      project({ type: "history_trimmed", reason: "token_budget", dropped_messages: 4 }).events[0],
    ).toMatchObject({
      turnItem: {
        type: "system_notice",
        message: "Context trimmed: token_budget (4 messages dropped)",
      },
    });
    expect(
      project({ type: "budget_warning", current_usd: 4.5, limit_usd: 5 }).events[0],
    ).toMatchObject({
      turnItem: { type: "system_notice", message: "Budget warning: $4.50 of $5.00 spent" },
    });
    expect(project({ type: "turn_complete", outcome: "cancelled" }).events[0]).toMatchObject({
      type: "turn.terminal",
      status: "cancelled",
    });
  });

  it("projects a failure as an error row the terminal points at", () => {
    const terminal = project({ type: "turn_complete", outcome: "failed", content: "boom" });
    const [item, event] = terminal.events;
    expect(item).toMatchObject({ turnItem: { type: "error", failure: { message: "boom" } } });
    expect(event).toMatchObject({
      type: "turn.terminal",
      status: "failed",
      failure: { message: "boom" },
      failureItemOrdinal: (item as { turnItem: { ordinal: number } }).turnItem.ordinal,
    });
  });

  it("keeps partial text when a turn is cancelled", () => {
    const current = state();
    project({ type: "agent_message_chunk", text: "half" }, current);
    const terminal = project(
      { type: "turn_complete", outcome: "cancelled", content: "half an answer" },
      current,
    );
    expect(terminal.events[0]).toMatchObject({
      turnItem: { text: "half an answer", streaming: false, status: "cancelled" },
    });
  });

  it("ignores an unknown update type", () => {
    expect(project({ type: "future_event", session_id: "s1" })).toEqual({ events: [] });
  });

  it("opens a subagent for a foreground spawn and settles it on the result", () => {
    const current = state();
    const opened = project(
      {
        type: "tool_call",
        tool_call_id: "c1",
        name: "spawn_subagent",
        raw_input: { prompt: "review", agent: "reviewer" },
      },
      current,
    );
    expect(opened.events.map((event) => event.type)).toEqual([
      "turn_item.updated",
      "subagent.updated",
    ]);
    const settled = project(
      { type: "tool_result", tool_call_id: "c1", name: "spawn_subagent", raw_output: "looks good" },
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
      tool_call_id: "c1",
      name: "delegate",
      raw_input: { action: "delegate", prompt: "look", background: true },
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

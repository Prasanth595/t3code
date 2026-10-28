import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  decodeAgentsListResult,
  decodeInitializeResult,
  decodeSessionMessagesResult,
  decodeSessionNewResult,
  decodeSessionPromptResult,
  decodeSessionStateResult,
  decodeSessionUpdate,
  decodeStatusResult,
} from "./protocol.ts";

const decode = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect);

describe("ZeroClaw protocol decoders", () => {
  it("decodes initialize, status, and agents/list", () => {
    expect(decode(decodeInitializeResult({ protocolVersion: 1, extra: true }))).toMatchObject({
      protocolVersion: 1,
    });
    expect(decode(decodeStatusResult({ version: "0.4.0" }))).toEqual({ version: "0.4.0" });
    expect(decode(decodeAgentsListResult({ agents: [{ alias: "coder", name: "Coder" }] }))).toEqual(
      { agents: [{ alias: "coder", name: "Coder" }] },
    );
  });

  it("decodes session results", () => {
    expect(decode(decodeSessionNewResult({ sessionId: "s1", agentAlias: "coder" }))).toEqual({
      sessionId: "s1",
      agentAlias: "coder",
    });
    expect(decode(decodeSessionPromptResult({ outcome: "completed" }))).toEqual({
      outcome: "completed",
    });
    expect(decode(decodeSessionStateResult({ sessionId: "s1", model: "gpt" }))).toMatchObject({
      sessionId: "s1",
      model: "gpt",
    });
    expect(
      decode(decodeSessionMessagesResult({ messages: [{ role: "user", content: "hi" }] })),
    ).toEqual({ messages: [{ role: "user", content: "hi" }] });
  });

  it("decodes each session/update type the adapter projects", () => {
    expect(
      decode(decodeSessionUpdate({ type: "agent_message_chunk", text: "hello", sessionId: "s1" })),
    ).toMatchObject({ type: "agent_message_chunk", text: "hello" });
    expect(
      decode(decodeSessionUpdate({ type: "agent_thought_chunk", text: "thinking" })),
    ).toMatchObject({ type: "agent_thought_chunk" });
    expect(
      decode(
        decodeSessionUpdate({
          type: "tool_call",
          toolCallId: "c1",
          name: "shell",
          input: { command: "ls" },
        }),
      ),
    ).toMatchObject({ type: "tool_call", name: "shell" });
    expect(
      decode(
        decodeSessionUpdate({
          type: "tool_result",
          toolCallId: "c1",
          status: "completed",
          output: "ok",
        }),
      ),
    ).toMatchObject({ type: "tool_result", status: "completed" });
    expect(
      decode(
        decodeSessionUpdate({
          type: "approval_request",
          requestId: "r1",
          toolName: "shell",
          argumentsSummary: "ls",
          timeoutSecs: 30,
        }),
      ),
    ).toMatchObject({ type: "approval_request", requestId: "r1" });
    expect(
      decode(
        decodeSessionUpdate({ type: "plan", items: [{ content: "step", status: "pending" }] }),
      ),
    ).toMatchObject({ type: "plan" });
    expect(
      decode(decodeSessionUpdate({ type: "context_usage", usedTokens: 10, maxTokens: 100 })),
    ).toMatchObject({ type: "context_usage", usedTokens: 10 });
    expect(
      decode(decodeSessionUpdate({ type: "history_trimmed", message: "trimmed" })),
    ).toMatchObject({ type: "history_trimmed" });
    expect(decode(decodeSessionUpdate({ type: "budget_warning", message: "low" }))).toMatchObject({
      type: "budget_warning",
    });
    expect(decode(decodeSessionUpdate({ type: "turn_complete", outcome: "cancelled" }))).toEqual({
      type: "turn_complete",
      outcome: "cancelled",
    });
  });

  it("decodes an unknown session/update type instead of failing", () => {
    expect(
      decode(decodeSessionUpdate({ type: "future_event", sessionId: "s1", extra: 1 })),
    ).toEqual({
      type: "future_event",
      sessionId: "s1",
    });
  });

  it("rejects a turn_complete with an unknown outcome", () => {
    const exit = Effect.runSyncExit(
      decodeSessionUpdate({ type: "turn_complete", outcome: "nope" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

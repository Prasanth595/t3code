import { describe, expect, it } from "@effect/vitest";

import { piUsageFormat } from "./usage.ts";

const timestamp = "2026-08-01T10:00:00Z";
const usage = { input: 100, output: 50, cost: { total: 0.25 } };

function parse(lines: readonly unknown[]) {
  const state = piUsageFormat.state!.initial();
  return lines.flatMap((line) => piUsageFormat.parseLine(JSON.stringify(line), state));
}

const assistant = (id: string, provider: string, model: string) => ({
  type: "message",
  id,
  timestamp,
  message: { role: "assistant", provider, model, usage },
});
const compaction = (id: string) => ({ type: "compaction", id, timestamp, usage });
const toolResult = (id: string) => ({
  type: "message",
  id,
  timestamp,
  message: { role: "toolResult", usage },
});

describe("piUsageFormat", () => {
  it("skips pi-ai's faux test provider and keeps real providers", () => {
    const records = parse([
      { type: "session", id: "s1" },
      assistant("a1", "faux", "faux-1"),
      { type: "usage", id: "u1", timestamp, provider: "faux", model: "faux-1", usage },
      assistant("a2", "anthropic", "claude-fable-5"),
    ]);
    expect(records.map((record) => record.model)).toEqual(["anthropic/claude-fable-5"]);
  });

  it("skips summaries a faux model wrote but keeps tool usage", () => {
    const records = parse([
      { type: "session", id: "s1" },
      assistant("a1", "faux", "faux-1"),
      compaction("c1"),
      toolResult("t1"),
      // A new session starts on a real model, so its summaries count again.
      { type: "session", id: "s2" },
      assistant("a2", "anthropic", "claude-fable-5"),
      compaction("c2"),
    ]);
    expect(records.map((record) => [record.sessionId, record.model])).toEqual([
      ["s1", "Tools/summaries"],
      ["s2", "anthropic/claude-fable-5"],
      ["s2", "Tools/summaries"],
    ]);
  });
});

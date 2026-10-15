import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { piUsageFormat } from "./usage.ts";

const timestamp = "2026-08-01T10:00:00Z";
const usage = { input: 100, output: 50, cost: { total: 0.25 } };

function parse(lines: readonly unknown[]) {
  const state = piUsageFormat.state!.initial();
  return lines.flatMap((line) => piUsageFormat.parseLine(JSON.stringify(line), state));
}

describe("piUsageFormat", () => {
  it("skips pi-ai's faux test provider and keeps real providers", () => {
    const records = parse([
      { type: "session", id: "s1" },
      {
        type: "message",
        id: "a1",
        timestamp,
        message: { role: "assistant", provider: "faux", model: "faux-1", usage },
      },
      { type: "usage", id: "u1", timestamp, provider: "faux", model: "faux-1", usage },
      {
        type: "message",
        id: "a2",
        timestamp,
        message: { role: "assistant", provider: "anthropic", model: "claude-fable-5", usage },
      },
    ]);
    expect(records.map((record) => record.model)).toEqual(["anthropic/claude-fable-5"]);
  });

  it("rejects scan state saved before faux records were skipped", () => {
    // The scan cache drops entries whose state fails this check, so files
    // cached with faux records re-parse instead of keeping them.
    const isState = Schema.is(piUsageFormat.state!.schema);
    expect(isState({ sessionId: "s1" })).toBe(false);
    expect(isState(piUsageFormat.state!.initial())).toBe(true);
  });
});

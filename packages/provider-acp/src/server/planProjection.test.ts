import { describe, expect, it } from "@effect/vitest";

import { planMarkdownFromExitPlanToolCall } from "./planProjection.ts";

function toolCall(overrides: {
  readonly title?: string;
  readonly rawInput?: unknown;
}): Parameters<typeof planMarkdownFromExitPlanToolCall>[0] {
  return {
    toolCallId: "tool-call-1",
    kind: "other",
    ...(overrides.title === undefined ? {} : { title: overrides.title }),
    data: overrides.rawInput === undefined ? {} : { rawInput: overrides.rawInput },
  };
}

describe("planMarkdownFromExitPlanToolCall", () => {
  it("captures the plan from an exit-plan tool call", () => {
    expect(
      planMarkdownFromExitPlanToolCall(
        toolCall({ title: "exit_plan_mode", rawInput: { plan: "Write hello.txt with hi." } }),
      ),
    ).toBe("Write hello.txt with hi.");
  });

  it("ignores tool calls that are not an exit-plan request", () => {
    expect(
      planMarkdownFromExitPlanToolCall(
        toolCall({ title: "write", rawInput: { plan: "not a plan" } }),
      ),
    ).toBeUndefined();
    expect(planMarkdownFromExitPlanToolCall(toolCall({ title: "exit_plan_mode" }))).toBeUndefined();
    expect(
      planMarkdownFromExitPlanToolCall(
        toolCall({ title: "exit_plan_mode", rawInput: { plan: "  " } }),
      ),
    ).toBeUndefined();
    expect(
      planMarkdownFromExitPlanToolCall(
        toolCall({ title: "exit_plan_mode", rawInput: { plan: 42 } }),
      ),
    ).toBeUndefined();
  });
});

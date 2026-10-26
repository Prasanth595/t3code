import { unknownRecord } from "./clientPolicy.ts";
import type { AcpToolCallState } from "./runtimeModel.ts";

// ACP has no exit-plan tool; agents that mirror Claude's flow name a tool call
// "exit_plan_mode" and put the plan markdown in rawInput.plan.
export function planMarkdownFromExitPlanToolCall(toolCall: AcpToolCallState): string | undefined {
  const title = (toolCall.title ?? "").trim().toLowerCase();
  if (!title.includes("exit_plan_mode") && !title.includes("exit plan mode")) return undefined;
  const plan = unknownRecord(toolCall.data.rawInput)?.plan;
  return typeof plan === "string" && plan.trim().length > 0 ? plan : undefined;
}

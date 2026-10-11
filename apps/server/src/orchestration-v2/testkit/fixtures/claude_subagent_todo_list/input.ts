import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_SUBAGENT_TODO_LIST_PROMPT =
  "Use TaskCreate to create exactly two tasks, in this order: Inspect package.json, Inspect tsconfig.json. Then use the Agent tool exactly once, with run_in_background set to false, and give the subagent this prompt: 'Read package.json. Then use TaskUpdate to mark task 1 completed, and use TaskCreate to create one task named Report completion. Reply exactly: subagent tasks updated.' Do not call TaskUpdate or TaskCreate yourself after launching the subagent. Wait for it, then answer exactly: claude subagent todo list complete";

export function claudeSubagentTodoListInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_SUBAGENT_TODO_LIST_PROMPT }],
  };
}

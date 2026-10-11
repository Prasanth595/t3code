import { CLAUDE_MODEL_SELECTION, type OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_TODO_LIST_FIRST_PROMPT =
  "Use TaskCreate to create exactly three tasks, in this order: Inspect package.json, Inspect tsconfig.json, Report completion. Then read package.json and use TaskUpdate to mark Inspect package.json completed. Do not update the other two tasks. Then answer exactly: claude todo list first turn complete";

export const CLAUDE_TODO_LIST_SECOND_PROMPT =
  "Read tsconfig.json, then use TaskUpdate to mark Inspect tsconfig.json completed and Report completion completed. Do not create new tasks. Then answer exactly: claude todo list second turn complete";

// Task tools replace TodoWrite on Claude 5 models, and only when the user opts
// in with CLAUDE_CODE_ENABLE_TODO_TOOLS.
export const CLAUDE_TODO_LIST_MODEL_SELECTION = {
  ...CLAUDE_MODEL_SELECTION,
  model: "claude-sonnet-5-5",
};

export function claudeTodoListInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_TODO_LIST_FIRST_PROMPT },
      { type: "message", text: CLAUDE_TODO_LIST_SECOND_PROMPT },
    ],
  };
}

import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_SUBAGENT_TODO_LIST_PROMPT } from "./input.ts";

export function assertClaudeSubagentTodoListOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 1,
    runStatuses: ["completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [CLAUDE_SUBAGENT_TODO_LIST_PROMPT]);
  assertAssistantTextIncludes(projection, "claude subagent todo list complete");

  // The subagent's TaskUpdate and TaskCreate land on the parent turn's list.
  const todoLists = projection.plans.filter((plan) => plan.kind === "todo_list");
  assert.deepEqual(
    todoLists.map((plan) => plan.runId),
    projection.runs.map((run) => run.id),
  );
  assert.deepEqual(
    todoLists.map((plan) => plan.steps.map((step) => [step.text, step.status])),
    [
      [
        ["Inspect package.json", "completed"],
        ["Inspect tsconfig.json", "pending"],
        ["Report completion", "pending"],
      ],
    ],
  );
}

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
import { CLAUDE_TODO_LIST_FIRST_PROMPT, CLAUDE_TODO_LIST_SECOND_PROMPT } from "./input.ts";

export function assertClaudeTodoListOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [
    CLAUDE_TODO_LIST_FIRST_PROMPT,
    CLAUDE_TODO_LIST_SECOND_PROMPT,
  ]);
  assertAssistantTextIncludes(projection, "claude todo list first turn complete");
  assertAssistantTextIncludes(projection, "claude todo list second turn complete");

  // Each turn gets its own todo list, and the second turn's list carries the
  // tasks created in the first.
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
      [
        ["Inspect package.json", "completed"],
        ["Inspect tsconfig.json", "completed"],
        ["Report completion", "completed"],
      ],
    ],
  );

  // Task updates within a turn edit that turn's plan in place.
  const planIds = new Set(
    result.domainEvents.flatMap((event) =>
      event.type === "plan.updated" ? [event.payload.id] : [],
    ),
  );
  assert.deepEqual(
    [...planIds],
    todoLists.map((plan) => plan.id),
  );
}

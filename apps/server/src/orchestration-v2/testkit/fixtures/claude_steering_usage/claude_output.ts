import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessageInputIntents,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertClaudeSteeringUsageOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.equal(transcript.provider, "claudeAgent");
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertUserMessagesInclude(projection, [
    MESSAGE_STEERING_INITIAL_PROMPT,
    MESSAGE_STEERING_STEER_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer"]);
  assertAssistantTextIncludes(projection, "steering fixture observed");
  assert.equal(projection.runs.length, 1, "steering must attach to the active run");
  assert.equal(
    projection.providerTurns.length,
    1,
    "active steering must not create a new provider turn",
  );

  // A steered turn settles two SDK results: the aborted pre-steer segment and
  // the post-steer success. Each result's usage covers only its own segment,
  // so billing the final result alone drops every call before the steer
  // (issue #18245). The turn's billable usage must sum both segments.
  const [providerTurn] = projection.providerTurns;
  assert.isDefined(providerTurn);
  assert.equal(providerTurn.status, "completed");
  assert.deepEqual(providerTurn.turnTokenUsage, {
    usageStatus: "complete",
    usageScope: "main_agent",
    hasSubagents: false,
    // 120 + 3 uncached, 2000 + 9455 cache reads, 500 + 2347 cache writes.
    inputTokens: 120 + 3 + 2000 + 500 + 9455 + 2347,
    cachedInputTokens: 2000 + 9455,
    cacheCreationTokens: 500 + 2347,
    outputTokens: 40 + 6,
    // Only the aborted segment reports thinking tokens; clamped to output.
    reasoningTokens: 20,
  });
}

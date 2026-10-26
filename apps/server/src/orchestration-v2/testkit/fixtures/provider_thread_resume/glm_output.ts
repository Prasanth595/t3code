import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  PROVIDER_THREAD_RESUME_FIRST_PROMPT,
  PROVIDER_THREAD_RESUME_SECOND_PROMPT,
} from "../shared.ts";

export function assertGlmProviderThreadResumeOutput(
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
  assertUserMessagesInclude(projection, [
    PROVIDER_THREAD_RESUME_FIRST_PROMPT,
    PROVIDER_THREAD_RESUME_SECOND_PROMPT,
  ]);
  assert.lengthOf(projection.providerThreads, 1);
  assertAssistantTextIncludes(projection, "provider thread resume fixture first turn complete");
  const answers = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.include(answers.at(-1), "provider thread resume fixture first turn complete");
  assert.include(answers.at(-1), "provider thread resume fixture second turn complete");
  assert.isTrue(
    transcript.entries.some((entry) => {
      if (entry.type !== "expect_outbound" || typeof entry.frame !== "object" || !entry.frame) {
        return false;
      }
      const method = Reflect.get(entry.frame, "method");
      return method === "session/load" || method === "session/resume";
    }),
    "the later turn must reopen the saved ACP session",
  );
}

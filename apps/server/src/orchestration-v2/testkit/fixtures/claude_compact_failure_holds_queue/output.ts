import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript, RunId } from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";
import { CLAUDE_COMPACT_QUEUED_PROMPT } from "./input.ts";

function assertCompactFailureHoldsQueue(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
  expected: { readonly code: string; readonly itemStatus: string },
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);

  const runUpdates = result.storedEvents.flatMap((stored) =>
    stored.event.type === "run.updated" ? [stored.event.payload] : [],
  );
  const [failedRunId, queuedRunId, retryRunId] = [
    ...new Set(runUpdates.map((run) => run.id)),
  ] as Array<RunId>;
  const runOf = (runId: RunId | undefined) => {
    const run = projection.runs.find((candidate) => candidate.id === runId);
    assert.isDefined(run);
    return run!;
  };
  const textOf = (runId: RunId | undefined) =>
    projection.messages.find((message) => message.id === runOf(runId).userMessageId)?.text;
  const itemsOf = (runId: RunId | undefined) =>
    projection.turnItems.filter((item) => item.runId === runId);
  assert.lengthOf(projection.runs, 3);
  assert.equal(textOf(failedRunId), "/compact");
  assert.equal(textOf(queuedRunId), CLAUDE_COMPACT_QUEUED_PROMPT);
  assert.equal(textOf(retryRunId), "/compact");

  // The failed /compact leaves the root error the scheduler reads.
  const failedRun = runOf(failedRunId);
  assert.equal(failedRun.status, "failed");
  const failure = latestRootProviderFailure(failedRun, projection.turnItems);
  assert.equal(failure?.class, "provider_error");
  assert.equal(failure?.code, expected.code);
  assert.deepEqual(
    itemsOf(failedRunId).flatMap((item) => (item.type === "compaction" ? [item.status] : [])),
    [expected.itemStatus],
  );

  // The queued message was held, and nothing dispatched it until the retry
  // had completed.
  const indexOf = (predicate: (run: (typeof runUpdates)[number]) => boolean) =>
    runUpdates.findIndex(predicate);
  const failedAt = indexOf((run) => run.id === failedRunId && run.status === "failed");
  const heldAt = indexOf((run) => run.id === queuedRunId && run.queueHeld === true);
  const retryStartedAt = indexOf((run) => run.id === retryRunId && run.status !== "queued");
  const retryCompletedAt = indexOf((run) => run.id === retryRunId && run.status === "completed");
  const queuedLeftQueueAt = indexOf((run) => run.id === queuedRunId && run.status !== "queued");
  assert.isAbove(failedAt, -1);
  assert.isAbove(heldAt, failedAt);
  assert.isAbove(retryStartedAt, heldAt);
  assert.isAbove(queuedLeftQueueAt, retryCompletedAt);

  const retryRun = runOf(retryRunId);
  assert.equal(retryRun.status, "completed");
  assert.deepEqual(
    itemsOf(retryRunId).flatMap((item) =>
      item.type === "compaction"
        ? [[item.status, item.beforeTokenCount, item.afterTokenCount]]
        : [],
    ),
    [["completed", 2400, 600]],
  );

  const queuedRun = runOf(queuedRunId);
  assert.equal(queuedRun.status, "completed");
  assert.isNotTrue(queuedRun.queueHeld);
  assert.deepEqual(
    itemsOf(queuedRunId).flatMap((item) =>
      item.type === "assistant_message" ? [item.text.trim()] : [],
    ),
    ["queued after compact"],
  );
}

export function assertClaudeCompactFailureHoldsQueueOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertCompactFailureHoldsQueue(result, transcript, {
    code: "compaction_failed",
    itemStatus: "failed",
  });
}

export function assertClaudeCompactUnconfirmedHoldsQueueOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertCompactFailureHoldsQueue(result, transcript, {
    code: "compaction_unconfirmed",
    itemStatus: "cancelled",
  });
}

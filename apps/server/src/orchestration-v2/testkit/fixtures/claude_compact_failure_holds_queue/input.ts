import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_COMPACT_QUEUED_PROMPT = "Respond with exactly: queued after compact";

// A /compact that does not succeed holds the message queued behind it. The
// user's retry releases the hold, and the queued message runs once after it.
// The transcripts are synthetic: the frames follow the CLI's status,
// compact_boundary and local_command result shapes.
export function claudeCompactFailureHoldsQueueInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: "/compact" },
      { type: "queue_message", text: CLAUDE_COMPACT_QUEUED_PROMPT },
      { type: "message", text: "/compact" },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}

import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getLatestCompletedCheckpointTurnCount } from "./threadCheckpoints.ts";

const completed = RunId.make("completed");
const running = RunId.make("running");
const failed = RunId.make("failed");

describe("getLatestCompletedCheckpointTurnCount", () => {
  it("returns zero before the first completed checkpoint", () => {
    expect(getLatestCompletedCheckpointTurnCount([], [])).toBe(0);
    expect(
      getLatestCompletedCheckpointTurnCount(
        [{ runId: running, appRunOrdinal: 1, status: "ready" }],
        [{ id: running, status: "running" }],
      ),
    ).toBe(0);
  });

  it("uses the highest ready completed ordinal regardless of ordering or history gaps", () => {
    expect(
      getLatestCompletedCheckpointTurnCount(
        [
          { runId: completed, appRunOrdinal: 28, status: "ready" },
          { runId: completed, appRunOrdinal: 27, status: "ready" },
          { runId: completed, appRunOrdinal: 29, status: "stale" },
          { runId: completed, appRunOrdinal: 30, status: "missing" },
          { runId: completed, appRunOrdinal: 31, status: "error" },
          { runId: running, appRunOrdinal: 32, status: "ready" },
          { runId: failed, appRunOrdinal: 33, status: "ready" },
          { runId: null, appRunOrdinal: 34, status: "ready" },
          { runId: completed, appRunOrdinal: null, status: "ready" },
        ],
        [
          { id: completed, status: "completed" },
          { id: running, status: "running" },
          { id: failed, status: "failed" },
        ],
      ),
    ).toBe(28);
  });
});

import { EnvironmentId, type OrchestrationV2ShellThreadStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { countRunningAgentTurns } from "./desktopUpdateIdleInstall.logic";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");

function thread(environmentId: EnvironmentId, status: OrchestrationV2ShellThreadStatus) {
  return { environmentId, source: { status } };
}

describe("countRunningAgentTurns", () => {
  it("counts turns that are queued or in progress, not drained or finished ones", () => {
    const threads = (
      [
        "preparing",
        "queued",
        "starting",
        "running",
        "waiting",
        "idle",
        "completed",
        "interrupted",
        "failed",
        "cancelled",
        "rolled_back",
      ] as const
    ).map((status) => thread(primary, status));

    expect(countRunningAgentTurns(threads, primary)).toBe(4);
  });

  it("counts only the environment that the update restarts", () => {
    const threads = [thread(primary, "running"), thread(remote, "running")];

    expect(countRunningAgentTurns(threads, primary)).toBe(1);
    expect(countRunningAgentTurns(threads, null)).toBe(0);
  });
});

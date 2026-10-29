import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildAdhdQueue } from "./adhdQueue.logic";

const environmentId = EnvironmentId.make("env-1");
const NOW = "2026-03-09T12:00:00.000Z";

function completedRun(completedAt: string) {
  return {
    runId: "run-1" as never,
    status: "completed" as const,
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt,
  };
}

function thread(
  id: string,
  project: string,
  overrides: Partial<Parameters<typeof buildAdhdQueue>[0]["threads"][number]> & {
    lastVisitedAt?: string;
  } = {},
) {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make(project),
    settledOverride: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: null,
    latestRun: completedRun("2026-03-09T11:00:00.000Z"),
    lastVisitedAt: "2026-03-09T10:30:00.000Z",
    ...overrides,
  };
}

const failedRuntime = {
  status: "failed" as const,
  providerName: "Codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  activeRunId: null,
  lastError: "boom",
  updatedAt: "2026-03-09T11:00:00.000Z",
};

function queueIds(threads: ReadonlyArray<ReturnType<typeof thread>>) {
  return buildAdhdQueue({
    threads,
    lastVisitedAt: (candidate) => candidate.lastVisitedAt,
    projectOrder: [`${environmentId}:project-a`, `${environmentId}:project-b`],
    now: NOW,
  }).map((entry) => `${entry.thread.id}:${entry.kind}`);
}

describe("buildAdhdQueue", () => {
  it("puts blocked agents first, then follows the sidebar's project order", () => {
    expect(
      queueIds([
        thread("done-b", "project-b"),
        thread("approval-b", "project-b", { hasPendingApprovals: true }),
        thread("done-a-older", "project-a", {
          latestRun: completedRun("2026-03-09T10:45:00.000Z"),
        }),
        thread("failed-a", "project-a", { runtime: failedRuntime }),
        thread("limited-b", "project-b", {
          runtime: { ...failedRuntime, lastErrorClass: "usage_limit" },
        }),
        thread("input-a", "project-a", { hasPendingUserInput: true }),
      ]),
    ).toEqual([
      "input-a:input",
      "approval-b:approval",
      "failed-a:failed",
      "done-a-older:done",
      "done-b:done",
      "limited-b:failed",
    ]);
  });

  it("leaves out working, seen, settled, and snoozed threads, and parents of asking subagents", () => {
    expect(
      queueIds([
        thread("parent-of-asking", "project-a", {
          pendingSubagentRequest: "approval",
          lastVisitedAt: "2026-03-09T11:30:00.000Z",
        }),
        thread("working", "project-a", {
          runtime: { ...failedRuntime, status: "running", activeRunId: "run-1" as never },
        }),
        thread("seen", "project-a", { lastVisitedAt: "2026-03-09T11:30:00.000Z" }),
        thread("settled", "project-a", { settledOverride: "settled" }),
        thread("snoozed", "project-a", {
          snoozedAt: "2026-03-09T11:50:00.000Z",
          snoozedUntil: "2026-03-09T12:15:00.000Z",
        }),
        thread("snoozed-asking", "project-a", {
          hasPendingApprovals: true,
          snoozedAt: "2026-03-09T11:50:00.000Z",
          snoozedUntil: "2026-03-09T12:15:00.000Z",
        }),
      ]),
    ).toEqual(["snoozed-asking:approval"]);
  });
});

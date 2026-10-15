import { describe, expect, it } from "@effect/vitest";

import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  Project,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderInstanceId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { projectThreadAwarenessV2 } from "./agentAwareness.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const project = {
  title: "t3code",
} satisfies Pick<Project, "title">;

describe("projectThreadAwarenessV2", () => {
  const updatedAt = DateTime.makeUnsafe(NOW);
  const v2Thread = (
    overrides: Partial<
      Pick<
        OrchestrationV2ThreadShell,
        | "activityRunStatus"
        | "status"
        | "pendingBackgroundTasks"
        | "pendingRuntimeRequest"
        | "lineage"
        | "lastVisitedAt"
        | "latestRunCompletedAt"
      >
    > = {},
  ) => ({
    id: "thread-2" as ThreadId,
    lineage: {
      rootThreadId: "thread-2" as ThreadId,
      parentThreadId: null,
      relationshipToParent: null,
    },
    title: "Integrate orchestration",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    status: "running" as const,
    pendingRuntimeRequest: null,
    updatedAt,
    ...overrides,
  });

  it("projects V2 run state", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread(),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it.each(["running", "completed", "failed"] as const)(
    "does not publish %s subagent activity",
    (status) => {
      expect(
        projectThreadAwarenessV2({
          environmentId: "env-1" as EnvironmentId,
          project,
          thread: v2Thread({
            status,
            lineage: {
              rootThreadId: "parent" as ThreadId,
              parentThreadId: "parent" as ThreadId,
              relationshipToParent: "subagent",
            },
          }),
        }),
      ).toBeNull();
    },
  );

  it("keeps an older activity run visible over a newer cancelled run", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "cancelled", activityRunStatus: "running" }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it.each([
    ["only a dev server", "completed", [{ taskId: "dev", kind: "command" }]],
    ["a monitor", "running", [{ taskId: "watch", kind: "monitor" }]],
    [
      "a dev server and a subagent",
      "running",
      [
        { taskId: "dev", kind: "command" },
        { taskId: "review", kind: "subagent" },
      ],
    ],
  ] as const)("reports a completed run waiting on %s as %s", (_case, phase, tasks) => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({ status: "completed", pendingBackgroundTasks: tasks }),
      }),
    ).toMatchObject({ phase });
  });

  it("prioritizes V2 user-input requests", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-1"),
            kind: "user_input",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "waiting_for_input", headline: "Waiting for input" });
  });

  it("does not present authentication refreshes as user approvals", () => {
    expect(
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread({
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-auth-refresh"),
            kind: "auth_refresh",
            createdAt: updatedAt,
          },
        }),
      }),
    ).toMatchObject({ phase: "running", headline: "Agent is working" });
  });

  it("marks a terminal state visited once its completion has been seen", () => {
    const completedAt = DateTime.makeUnsafe("2026-05-22T11:59:00.000Z");
    const awareness = (overrides: Parameters<typeof v2Thread>[0]) =>
      projectThreadAwarenessV2({
        environmentId: "env-1" as EnvironmentId,
        project,
        thread: v2Thread(overrides),
      });
    expect(
      awareness({ status: "completed", latestRunCompletedAt: completedAt, lastVisitedAt: null }),
    ).not.toHaveProperty("visited");
    expect(
      awareness({
        status: "completed",
        latestRunCompletedAt: completedAt,
        lastVisitedAt: DateTime.makeUnsafe("2026-05-22T11:58:00.000Z"),
      }),
    ).not.toHaveProperty("visited");
    expect(
      awareness({
        status: "failed",
        latestRunCompletedAt: completedAt,
        lastVisitedAt: completedAt,
      }),
    ).toMatchObject({ phase: "failed", visited: true });
    // Running states never carry the flag, so streaming watermarks cannot churn publishes.
    expect(
      awareness({ status: "running", latestRunCompletedAt: completedAt, lastVisitedAt: updatedAt }),
    ).not.toHaveProperty("visited");
  });
});

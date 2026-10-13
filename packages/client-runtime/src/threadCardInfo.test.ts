import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadCardInfo, type ThreadCardInfoSource } from "./threadCardInfo.ts";

// Only the count of background tasks matters to the card.
const task = {} as ThreadCardInfoSource["pendingBackgroundTasks"][number];

const base: ThreadCardInfoSource = {
  runtimeMode: "full-access",
  interactionMode: "default",
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  goal: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make("t1") },
  runtime: null,
  visibleItemCount: 0,
  createdAt: "2026-10-13T10:00:00.000Z",
};

function failedRuntime(lastErrorClass: "usage_limit" | null) {
  return {
    status: "failed" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("claude"),
    providerName: null,
    lastError: "Rate limited",
    lastErrorClass,
    usageLimitResetAt: "2026-10-13T14:30:00.000Z",
    updatedAt: "2026-10-13T10:05:00.000Z",
  };
}

describe("resolveThreadCardInfo", () => {
  it("leaves every optional element out for a plain idle thread", () => {
    expect(resolveThreadCardInfo(base)).toEqual({
      access: "full-access",
      plan: null,
      backgroundTaskCount: null,
      goal: null,
      lineage: null,
      limitResetAt: null,
      error: null,
      messageCount: null,
      createdAt: base.createdAt,
    });
  });

  it("prefers a waiting plan over plan mode", () => {
    expect(resolveThreadCardInfo({ ...base, interactionMode: "plan" }).plan).toBe("mode");
    expect(
      resolveThreadCardInfo({ ...base, interactionMode: "plan", hasActionableProposedPlan: true })
        .plan,
    ).toBe("ready");
  });

  it("counts background tasks and messages", () => {
    const info = resolveThreadCardInfo({
      ...base,
      pendingBackgroundTasks: [task, task],
      visibleItemCount: 42,
    });
    expect(info.backgroundTaskCount).toBe(2);
    expect(info.messageCount).toBe(42);
  });

  it("drops a met goal and keeps one that still drives the thread", () => {
    expect(
      resolveThreadCardInfo({ ...base, goal: { objective: "Ship it", status: "complete" } }).goal,
    ).toBeNull();
    expect(
      resolveThreadCardInfo({ ...base, goal: { objective: "Ship it", status: "active" } }).goal,
    ).toEqual({ objective: "Ship it", status: "active" });
  });

  it("shows the limit reset only for a usage limit, and the error for any failure", () => {
    const limited = resolveThreadCardInfo({ ...base, runtime: failedRuntime("usage_limit") });
    expect(limited.limitResetAt).toBe("2026-10-13T14:30:00.000Z");
    expect(limited.error).toBe("Rate limited");
    const failed = resolveThreadCardInfo({ ...base, runtime: failedRuntime(null) });
    expect(failed.limitResetAt).toBeNull();
    expect(failed.error).toBe("Rate limited");
  });

  it("reads the relationship to a parent thread", () => {
    expect(
      resolveThreadCardInfo({
        ...base,
        lineage: { ...base.lineage, relationshipToParent: "subagent" },
      }).lineage,
    ).toBe("subagent");
  });
});

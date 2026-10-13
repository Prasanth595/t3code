import type { OrchestrationV2ProviderGoal, RuntimeMode } from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./state/models.ts";

/**
 * What the optional thread card elements show for one thread, from data the
 * thread shell already carries. Web and mobile render it; null leaves an
 * element out. Unread and the model label stay with each client, because
 * they depend on client state (visited marks, the provider catalog).
 */
export interface ThreadCardInfo {
  readonly access: RuntimeMode;
  /** `mode` while the thread runs in plan mode, `ready` when a plan waits for an answer. */
  readonly plan: "mode" | "ready" | null;
  readonly backgroundTaskCount: number | null;
  /** The provider goal while it still drives the thread. A met goal drops out. */
  readonly goal: Pick<OrchestrationV2ProviderGoal, "objective" | "status"> | null;
  readonly lineage: "fork" | "subagent" | null;
  /** When a usage limit that stopped the thread lifts. */
  readonly limitResetAt: string | null;
  /** The last error, while the thread is failed or limited. */
  readonly error: string | null;
  readonly messageCount: number | null;
  readonly createdAt: string;
}

export type ThreadCardInfoSource = Pick<
  EnvironmentThreadShell,
  | "runtimeMode"
  | "interactionMode"
  | "hasActionableProposedPlan"
  | "pendingBackgroundTasks"
  | "goal"
  | "lineage"
  | "runtime"
  | "visibleItemCount"
  | "createdAt"
>;

export function resolveThreadCardInfo(thread: ThreadCardInfoSource): ThreadCardInfo {
  // A failed run is "limited" when a usage limit stopped it, as the sidebar status reads it.
  const failed = thread.runtime?.status === "failed";
  const limited = failed && thread.runtime?.lastErrorClass === "usage_limit";
  return {
    access: thread.runtimeMode,
    plan: thread.hasActionableProposedPlan
      ? "ready"
      : thread.interactionMode === "plan"
        ? "mode"
        : null,
    backgroundTaskCount:
      thread.pendingBackgroundTasks.length > 0 ? thread.pendingBackgroundTasks.length : null,
    goal:
      thread.goal === null || thread.goal.status === "complete"
        ? null
        : { objective: thread.goal.objective, status: thread.goal.status },
    lineage: thread.lineage.relationshipToParent,
    limitResetAt: limited ? (thread.runtime?.usageLimitResetAt ?? null) : null,
    error: failed ? (thread.runtime?.lastError ?? null) : null,
    messageCount: thread.visibleItemCount > 0 ? thread.visibleItemCount : null,
    createdAt: thread.createdAt,
  };
}

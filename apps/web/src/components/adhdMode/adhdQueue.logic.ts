import {
  effectiveSnoozed,
  threadWokeAt,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";

import type { SidebarThreadSummary } from "../../types";
import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";

export type AdhdCardKind = "approval" | "input" | "failed" | "done";

type AdhdQueueThread = Parameters<typeof resolveSidebarThreadStatus>[0] &
  Parameters<typeof hasUnseenCompletion>[0] &
  ThreadSnoozeShell &
  Pick<SidebarThreadSummary, "environmentId" | "projectId" | "settledOverride">;

export interface AdhdQueueEntry<T extends AdhdQueueThread = SidebarThreadSummary> {
  readonly thread: T;
  readonly kind: AdhdCardKind;
  /** The agent is blocked until the user answers. */
  readonly urgent: boolean;
}

function resolveCardKind(
  thread: AdhdQueueThread,
  lastVisitedAt: string | undefined,
  now: string,
): AdhdCardKind | null {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval") return "approval";
  if (status === "input") return "input";
  if (status === "failed") return "failed";
  if (status !== "ready") return null;
  const wokeAt = threadWokeAt(thread, { now });
  const woke = wokeAt !== null && (lastVisitedAt === undefined || lastVisitedAt < wokeAt);
  return woke || hasUnseenCompletion({ ...thread, lastVisitedAt }) ? "done" : null;
}

/**
 * Threads that need the user, blocked agents first, then in the sidebar's
 * project order. Working, settled, and snoozed threads stay out.
 */
export function buildAdhdQueue<T extends AdhdQueueThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly lastVisitedAt: (thread: T) => string | undefined;
  /** Keys are `${environmentId}:${projectId}`, in sidebar order. */
  readonly projectOrder: ReadonlyArray<string>;
  readonly now: string;
}): AdhdQueueEntry<T>[] {
  const projectRank = new Map(input.projectOrder.map((key, index) => [key, index]));
  const rankOf = (thread: T) =>
    projectRank.get(`${thread.environmentId}:${thread.projectId}`) ?? projectRank.size;
  const entries: AdhdQueueEntry<T>[] = [];
  for (const thread of input.threads) {
    if (thread.settledOverride === "settled") continue;
    if (effectiveSnoozed(thread, { now: input.now })) continue;
    const kind = resolveCardKind(thread, input.lastVisitedAt(thread), input.now);
    if (kind === null) continue;
    entries.push({ thread, kind, urgent: kind === "approval" || kind === "input" });
  }
  return entries.toSorted(
    (left, right) =>
      Number(right.urgent) - Number(left.urgent) ||
      rankOf(left.thread) - rankOf(right.thread) ||
      (right.thread.latestRun?.completedAt ?? "").localeCompare(
        left.thread.latestRun?.completedAt ?? "",
      ),
  );
}

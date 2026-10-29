import type { EnvironmentThreadShell } from "./models.ts";
import { effectiveSnoozed, threadWokeAt, type ThreadSnoozeShell } from "./threadSettled.ts";

export type AdhdCardKind = "approval" | "input" | "failed" | "done";

export type AdhdQueueThread = ThreadSnoozeShell &
  Pick<
    EnvironmentThreadShell,
    | "environmentId"
    | "projectId"
    | "settledOverride"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "latestRun"
  > &
  Partial<Pick<EnvironmentThreadShell, "pendingSubagentRequest">>;

export interface AdhdQueueEntry<T extends AdhdQueueThread = EnvironmentThreadShell> {
  readonly thread: T;
  readonly kind: AdhdCardKind;
  /** The agent is blocked until the user answers. */
  readonly urgent: boolean;
}

/**
 * Threads that need the user, blocked agents first, then in the thread list's
 * project order. Working, settled, and snoozed threads stay out. Each client
 * passes its own thread list's status rules.
 */
export function buildAdhdQueue<T extends AdhdQueueThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly lastVisitedAt: (thread: T) => string | undefined;
  readonly status: (thread: T) => string;
  readonly hasUnseenCompletion: (thread: T, lastVisitedAt: string | undefined) => boolean;
  /** Keys are `${environmentId}:${projectId}`, in thread list order. */
  readonly projectOrder: ReadonlyArray<string>;
  readonly now: string;
}): AdhdQueueEntry<T>[] {
  const resolveCardKind = (thread: T): AdhdCardKind | null => {
    if (thread.hasPendingApprovals) return "approval";
    if (thread.hasPendingUserInput) return "input";
    // A subagent's request is answered in its own thread, which gets its own card.
    const status = input.status({ ...thread, pendingSubagentRequest: null });
    if (status === "failed" || status === "limited") return "failed";
    if (status !== "ready") return null;
    const lastVisitedAt = input.lastVisitedAt(thread);
    const wokeAt = threadWokeAt(thread, { now: input.now });
    const woke = wokeAt !== null && (lastVisitedAt === undefined || lastVisitedAt < wokeAt);
    return woke || input.hasUnseenCompletion(thread, lastVisitedAt) ? "done" : null;
  };
  const projectRank = new Map(input.projectOrder.map((key, index) => [key, index]));
  const rankOf = (thread: T) =>
    projectRank.get(`${thread.environmentId}:${thread.projectId}`) ?? projectRank.size;
  const entries: AdhdQueueEntry<T>[] = [];
  for (const thread of input.threads) {
    if (thread.settledOverride === "settled") continue;
    if (effectiveSnoozed(thread, { now: input.now })) continue;
    const kind = resolveCardKind(thread);
    if (kind === null) continue;
    entries.push({ thread, kind, urgent: kind === "approval" || kind === "input" });
  }
  return [...entries].sort(
    (left, right) =>
      Number(right.urgent) - Number(left.urgent) ||
      rankOf(left.thread) - rankOf(right.thread) ||
      (right.thread.latestRun?.completedAt ?? "").localeCompare(
        left.thread.latestRun?.completedAt ?? "",
      ),
  );
}

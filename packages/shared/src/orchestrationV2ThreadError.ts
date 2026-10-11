import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Only a failed root turn of the current run owns the thread's failure state. */
export function latestRootProviderFailure(
  run: OrchestrationV2Run | null,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ProviderFailure | null {
  if (run?.status !== "failed") return null;
  let latest: Extract<OrchestrationV2TurnItem, { type: "error" }> | null = null;
  for (const item of turnItems) {
    if (
      item.type !== "error" ||
      item.status !== "failed" ||
      item.runId !== run.id ||
      item.nodeId !== run.rootNodeId
    )
      continue;
    if (
      latest === null ||
      DateTime.toEpochMillis(item.updatedAt) > DateTime.toEpochMillis(latest.updatedAt) ||
      (DateTime.toEpochMillis(item.updatedAt) === DateTime.toEpochMillis(latest.updatedAt) &&
        (item.ordinal > latest.ordinal || (item.ordinal === latest.ordinal && item.id > latest.id)))
    ) {
      latest = item;
    }
  }
  return latest?.failure ?? null;
}

/** A distinct session failure supersedes the turn's classification. */
export function threadErrorSummary(
  failure: OrchestrationV2ProviderFailure | null,
  sessionError: string | null,
) {
  const currentFailure =
    sessionError !== null && sessionError !== failure?.message ? null : failure;
  return {
    usageLimitResetAt:
      currentFailure?.class === "usage_limit" ? (currentFailure.resetAt ?? null) : null,
    lastError: sessionError ?? failure?.message ?? null,
    lastErrorClass:
      sessionError !== null && sessionError !== failure?.message ? null : (failure?.class ?? null),
  };
}

export function latestExecutedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued") continue;
    if (run.status === "cancelled" && run.startedAt === null) continue;
    if (latest === null || runRanAfter(run, latest)) latest = run;
  }
  return latest;
}

/** A promptless retry needs the original input in the thread the provider will resume. */
export function promptlessContinuationRun(
  projection: OrchestrationV2ThreadProjection,
  supported: boolean,
): OrchestrationV2Run | null {
  if (
    !supported ||
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null ||
    projection.runtimeRequests.some((request) => request.status === "pending") ||
    projection.runs.some((run) =>
      ["preparing", "starting", "running", "waiting"].includes(run.status),
    )
  )
    return null;
  const run = latestExecutedRun(projection.runs);
  if (
    run === null ||
    (run.status !== "failed" && run.status !== "interrupted") ||
    run.providerInstanceId !== projection.thread.providerInstanceId ||
    run.providerThreadId !== projection.thread.activeProviderThreadId
  )
    return null;
  const nativeThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  if (
    nativeThread === undefined ||
    nativeThread.ownerNodeId !== null ||
    nativeThread.providerInstanceId !== run.providerInstanceId ||
    nativeThread.nativeThreadRef?.strength !== "strong" ||
    !nativeThread.nativeThreadRef.nativeId ||
    nativeThread.status === "closed" ||
    nativeThread.status === "archived"
  )
    return null;
  let historyRun = run;
  while (true) {
    if (
      projection.providerTurns.some(
        (turn) =>
          turn.nodeId === historyRun.rootNodeId &&
          turn.providerThreadId === nativeThread.id &&
          projection.attempts.some(
            (attempt) =>
              attempt.id === turn.runAttemptId &&
              attempt.runId === historyRun.id &&
              attempt.nativeThreadId === nativeThread.nativeThreadRef?.nativeId,
          ),
      )
    )
      return run;
    // A validated continuation can fail before admission without changing the
    // native input. Retry that run using its original admission evidence.
    const source = projection.runs.find(
      (candidate) =>
        candidate.id === historyRun.manualContinuationOfRunId &&
        candidate.ordinal < historyRun.ordinal &&
        candidate.providerInstanceId === run.providerInstanceId &&
        candidate.providerThreadId === run.providerThreadId &&
        (candidate.status === "failed" || candidate.status === "interrupted"),
    );
    if (source === undefined) return null;
    historyRun = source;
  }
}

/**
 * Whether started `run` ran after `other`. Ordinals follow submission, but a
 * run can start ahead of a held queue (a restart continuation, or a message
 * sent while the queue is held), so a queued run resumed later can have a
 * lower ordinal than one that already ended. An unfinished run is the latest.
 */
export function runRanAfter(
  run: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
  other: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
): boolean {
  const end = (candidate: typeof run) =>
    !candidate.completedAt
      ? Number.POSITIVE_INFINITY
      : DateTime.toEpochMillis(candidate.completedAt);
  return end(run) === end(other) ? run.ordinal > other.ordinal : end(run) > end(other);
}

/**
 * The latest run that actually started, when it stopped because the
 * subscription limit was reached. Queued messages after that run must stay
 * queued instead of being sent into the same limit.
 */
export function usageLimitBlockedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const executed = latestExecutedRun(runs);
  if (executed?.status !== "failed") return null;
  const summary = threadErrorSummary(latestRootProviderFailure(executed, turnItems), sessionError);
  return summary.lastErrorClass === "usage_limit" ? executed : null;
}

/**
 * That limited run, when newer runs were queued or cancelled before starting.
 * Callers that treat the highest-ordinal run as the thread outcome would
 * otherwise hide the limit.
 */
export function usageLimitRunPresentedAsLatest(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const blocked = usageLimitBlockedRun(runs, turnItems, sessionError);
  return blocked !== null && runs.some((run) => run.ordinal > blocked.ordinal) ? blocked : null;
}

/**
 * The newest run that is not waiting in a held queue, or null when only held
 * runs exist. A held queue waits for the user, so its runs never stand for the
 * thread's outcome. The SQL thread shell selects the same run.
 */
export function latestUnheldRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued" && run.queueHeld === true) continue;
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  return latest;
}

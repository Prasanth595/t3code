import type { RunId } from "@t3tools/contracts";
import type {
  ThreadStructure,
  ThreadStructureVisibleTurnItem,
} from "@t3tools/client-runtime/state/models";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  return formatDuration(elapsedSeconds * 1_000);
}

export function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

const IN_PROGRESS_ITEM_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "waiting"]);

/**
 * When the run's current attempt last showed activity, or null while one of its items is still
 * in progress, since a long command can be silent without being stuck. A restart supersedes the
 * attempt without closing its items, so those neither count as in progress nor move the baseline
 * past the new attempt's start.
 */
export function deriveActiveTurnLastActivityAt(input: {
  readonly projection: Pick<ThreadStructure, "runs" | "attempts" | "providerTurns">;
  readonly runId: RunId;
  readonly workStartedAt: string | null;
  readonly items: ReadonlyArray<ThreadStructureVisibleTurnItem>;
}): string | null {
  const run = input.projection.runs.find((candidate) => candidate.id === input.runId);
  const attempt = input.projection.attempts.find(
    (candidate) => candidate.id === run?.activeAttemptId,
  );
  const isSuperseded = (providerTurnId: string | null) => {
    if (providerTurnId === null || attempt === undefined) return false;
    const attemptId = input.projection.providerTurns.find(
      (turn) => turn.id === providerTurnId,
    )?.runAttemptId;
    return attemptId != null && attemptId !== attempt.id;
  };
  let latestMs = input.workStartedAt === null ? Number.NaN : Date.parse(input.workStartedAt);
  const observe = (at: DateTime.Utc | null | undefined) => {
    if (at == null) return;
    const atMs = DateTime.toEpochMillis(at);
    if (!(atMs <= latestMs)) latestMs = atMs;
  };
  observe(attempt?.startedAt);
  for (const { item } of input.items) {
    if (item.runId !== input.runId || isSuperseded(item.providerTurnId)) continue;
    if (IN_PROGRESS_ITEM_STATUSES.has(item.status)) return null;
    observe(item.startedAt);
    observe(item.completedAt);
    // The structure drops updatedAt from streamed text rows; their completion marks the activity.
    if ("updatedAt" in item) observe(item.updatedAt);
  }
  return Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : null;
}

const IDLE_HINT_AFTER_MS = 3 * 60_000;

export function formatIdleHint(lastActivityAt: string | null, nowMs: number): string | null {
  if (lastActivityAt === null) return null;
  const idleMs = nowMs - Date.parse(lastActivityAt);
  if (!(idleMs >= IDLE_HINT_AFTER_MS)) return null;
  return `No activity for ${formatDuration(Math.floor(idleMs / 60_000) * 60_000)}`;
}

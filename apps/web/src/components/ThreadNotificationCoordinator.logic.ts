import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

export function resolveThreadCompletionNotification(
  thread: Pick<EnvironmentThreadShell, "latestRun">,
  ready: boolean,
  previousCompletion: number | null,
  stopRequested: boolean,
): { completion: number | null; notify: boolean } {
  const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
  const completion =
    ready && thread.latestRun?.status === "completed" && Number.isFinite(completedAt)
      ? completedAt
      : previousCompletion;
  return {
    completion,
    notify:
      !stopRequested &&
      completion !== null &&
      (previousCompletion === null || completion > previousCompletion),
  };
}

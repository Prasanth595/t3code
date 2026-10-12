import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, OrchestrationV2ShellThreadStatus } from "@t3tools/contracts";

// "waiting" is left out: the agent turn is over and only the checkpoint drains.
const RUNNING_AGENT_STATUSES: ReadonlySet<OrchestrationV2ShellThreadStatus> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
]);

/**
 * Counts the threads, subagents included, whose agent turn runs on the
 * environment that a desktop update restarts.
 */
export function countRunningAgentTurns(
  threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId"> & {
      readonly source: Pick<EnvironmentThreadShell["source"], "status">;
    }
  >,
  environmentId: EnvironmentId | null,
): number {
  if (environmentId === null) return 0;
  return threads.filter(
    (thread) =>
      thread.environmentId === environmentId && RUNNING_AGENT_STATUSES.has(thread.source.status),
  ).length;
}

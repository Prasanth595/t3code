import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  isProviderNativeSubagentThread,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";

const LISTED_THREAD_LIMIT = 3;

/**
 * Environments whose server this desktop app runs, so quitting stops their
 * work: the primary local backend and desktop-local secondaries such as WSL.
 * Remote, SSH, and relay environments keep running.
 */
export function isDesktopOwnedTarget(target: ConnectionTarget): boolean {
  return target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target);
}

/**
 * A thread whose work stops when its server does: a run in progress, including
 * one waiting on subagents or input, or settled work the agent is still
 * waiting on. Provider-native subagents are counted through their parent.
 */
export function isBusyThreadShell(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "activityRunStatus" | "pendingBackgroundTasks" | "lineage" | "creationSource"
  >,
): boolean {
  if (isProviderNativeSubagentThread(thread)) return false;
  return (
    thread.activityRunStatus != null ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  );
}

/** Confirmation copy for quitting while the given threads are busy. */
export function formatQuitConfirmation(
  appName: string,
  threadTitles: readonly [string, ...string[]],
): string {
  if (threadTitles.length === 1) {
    return [`Quit ${appName}?`, `"${threadTitles[0]}" is still working. Quitting stops it.`].join(
      "\n",
    );
  }
  const listed = threadTitles.slice(0, LISTED_THREAD_LIMIT).map((title) => `"${title}"`);
  const unlisted = threadTitles.length - listed.length;
  return [
    `Quit ${appName}?`,
    `${threadTitles.length} threads are still working. Quitting stops them: ${listed.join(", ")}${
      unlisted > 0 ? `, and ${unlisted} more` : ""
    }.`,
  ].join("\n");
}

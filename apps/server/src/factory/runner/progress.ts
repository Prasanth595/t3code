/**
 * What a run's ledger already records, for a step that must not do twice what is done. The part
 * of softfac's `runner/progress.rs` the claim needs; later steps add what they read.
 */

import { isState, type State } from "../domain/lifecycle.ts";
import type { Entry } from "../ledger/read.ts";

export interface Seen {
  readonly claimed: boolean;
  /** The moment in the first `approved <time>` step: when an instructor applied the label the run was approved on. */
  readonly approvedAt: string | null;
  /** From the last `state_changed`; null before any. */
  readonly state: State | null;
  /** The `session_launched` line's thread. */
  readonly threadId: string | null;
  /** The `launch-sending` step: a launch call was about to be sent, so a session may exist. */
  readonly launchSent: boolean;
  /** The `approval-rechecked` step: the issue text was checked again after the launch. */
  readonly rechecked: boolean;
  /** The `session_launched` line's worktree path. */
  readonly worktree: string | null;
  /** A `worktree_removed` or `worktree_remove_failed` line follows the last `session_launched`. */
  readonly worktreeDone: boolean;
  /** The reason on the `stuck` line: the comment is on the issue. */
  readonly stuck: string | null;
  readonly finished: boolean;
}

const LAUNCH_SENDING = "launch-sending";

const field = (data: unknown, key: string): unknown =>
  typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined;

export const readProgress = (entries: ReadonlyArray<Entry>): Seen => {
  let claimed = false;
  let approvedAt: string | null = null;
  let state: State | null = null;
  let threadId: string | null = null;
  let launchSent = false;
  let rechecked = false;
  let worktree: string | null = null;
  let worktreeDone = false;
  let stuck: string | null = null;
  let finished = false;
  for (const entry of entries) {
    switch (entry.event) {
      case "claimed":
        claimed = true;
        break;
      case "step_changed": {
        const step = field(entry.data, "step");
        if (approvedAt === null && typeof step === "string" && step.startsWith("approved ")) {
          approvedAt = step.slice("approved ".length);
        }
        if (step === "approval-rechecked") rechecked = true;
        if (
          typeof step === "string" &&
          (step === LAUNCH_SENDING || step.startsWith(`${LAUNCH_SENDING} resumed-from `))
        ) {
          launchSent = true;
        }
        break;
      }
      case "state_changed": {
        const to = field(entry.data, "to");
        state = isState(to) ? to : null;
        break;
      }
      case "session_launched": {
        const id = field(entry.data, "thread_id");
        if (typeof id === "string") threadId = id;
        const path = field(entry.data, "worktree");
        worktree = typeof path === "string" ? path : null;
        worktreeDone = false;
        break;
      }
      case "worktree_removed":
      case "worktree_remove_failed":
        worktreeDone = true;
        break;
      case "stuck": {
        const reason = field(entry.data, "reason");
        stuck = typeof reason === "string" ? reason : "";
        break;
      }
      case "finished":
        finished = true;
        break;
    }
  }
  return {
    claimed,
    approvedAt,
    state,
    threadId,
    launchSent,
    rechecked,
    worktree,
    worktreeDone,
    stuck,
    finished,
  };
};

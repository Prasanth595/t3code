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
  /** Every pull request a `pr_opened` line names, in order. */
  readonly opened: ReadonlyArray<number>;
  /** The newest `pr_opened`: the number and the URL as the session wrote it. */
  readonly lastPr: { readonly pr: number; readonly url: string } | null;
  /** A `questions_posted` since the run last entered `building`: this stop's questions are on the issue. */
  readonly questionsPosted: boolean;
  /** A `pr_opened` since the run last entered `building`: the session's pull request waits for the gate. */
  readonly prReported: boolean;
  /** The ordinal in the newest `result-line-reminding` step: a reminder send was started. */
  readonly reminding: number | null;
  /** A `result-line-reminded` step: the session has had its one reminder. */
  readonly reminded: boolean;
  /**
   * The session is working until a run newer than this ordinal has ended: the reminder's (or a
   * forward's) wait marker. Never goes down.
   */
  readonly waitingAfter: number | null;
  /** The newest `session_paused` line: a person stopped the session's run in T3, and this is its ordinal. */
  readonly paused: { readonly runOrdinal: number | null } | null;
  /** Milliseconds spent in `triage` and `building` in stints that have ended. */
  readonly workedMs: number;
  /** When the stint that is running began; null when the run is not working. */
  readonly workingSince: number | null;
}

/** The ledger step that says a launch call is about to be sent. */
export const LAUNCH_SENDING = "launch-sending";
/** The ledger step that says the issue text was checked again after the launch. */
export const APPROVAL_RECHECKED = "approval-rechecked";
/** The ledger step written before the reminder is sent: `result-line-reminding <k>`, `k` the ordinal of the run that ended. */
export const RESULT_LINE_REMINDING = "result-line-reminding";
/** The ledger step written after the reminder was sent. */
export const RESULT_LINE_REMINDED = "result-line-reminded";
/** The ledger step that waits for a run newer than `k` (a forwarded comment); read here for the steps that write it. */
export const FORWARD_WAIT = "forward-wait";

const field = (data: unknown, key: string): unknown =>
  typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined;

/** The `k` of a step written as `<name> <k>`, `k` a number without a sign or leading zero. */
const stepNumber = (step: string, name: string): number | null => {
  if (!step.startsWith(`${name} `)) return null;
  const rest = step.slice(name.length + 1);
  return /^(?:0|[1-9][0-9]*)$/.test(rest) && Number.isSafeInteger(Number(rest))
    ? Number(rest)
    : null;
};

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
  const opened: Array<number> = [];
  let lastPr: Seen["lastPr"] = null;
  let questionsPosted = false;
  let prReported = false;
  let reminding: number | null = null;
  let reminded = false;
  let waitingAfter: number | null = null;
  let paused: Seen["paused"] = null;
  let workedMs = 0;
  let workingSince: number | null = entries[0]?.ms ?? null;
  // A wait marker names run `k`: the awaited ordinal never goes down.
  const awaitRun = (k: number) => {
    if (waitingAfter === null || k >= waitingAfter) waitingAfter = k;
  };
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
        if (step === APPROVAL_RECHECKED) rechecked = true;
        if (step === RESULT_LINE_REMINDED) reminded = true;
        if (typeof step === "string") {
          const remindingRun = stepNumber(step, RESULT_LINE_REMINDING);
          if (remindingRun !== null) {
            reminding = remindingRun;
            awaitRun(remindingRun);
          }
          const forwardRun = stepNumber(step, FORWARD_WAIT);
          if (forwardRun !== null) awaitRun(forwardRun);
        }
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
        if (workingSince !== null) workedMs += Math.max(0, entry.ms - workingSince);
        workingSince = null;
        // A pull request that was ready and comes back to building starts a new stint: the build
        // before it was ready came within the limit and is not charged again.
        if (state === "pr-open" && to === "building") workedMs = 0;
        if (to === "triage" || to === "building") workingSince = entry.ms;
        state = isState(to) ? to : null;
        if (to === "building") {
          questionsPosted = false;
          prReported = false;
        }
        break;
      }
      case "session_launched": {
        const id = field(entry.data, "thread_id");
        if (typeof id === "string") threadId = id;
        const path = field(entry.data, "worktree");
        worktree = typeof path === "string" ? path : null;
        worktreeDone = false;
        // A new session has run numbers of its own, one reminder, and no stop by hand yet.
        waitingAfter = null;
        reminding = null;
        reminded = false;
        paused = null;
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
      case "questions_posted":
        questionsPosted = true;
        break;
      case "pr_opened": {
        const pr = field(entry.data, "pr");
        const url = field(entry.data, "url");
        if (typeof pr === "number" && typeof url === "string") {
          opened.push(pr);
          lastPr = { pr, url };
          prReported = true;
        }
        break;
      }
      case "session_paused": {
        const ordinal = field(entry.data, "run_ordinal");
        paused = { runOrdinal: typeof ordinal === "number" ? ordinal : null };
        break;
      }
      case "finished":
        finished = true;
        workingSince = null;
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
    opened,
    lastPr,
    questionsPosted,
    prReported,
    reminding,
    reminded,
    waitingAfter,
    paused,
    workedMs,
    workingSince,
  };
};

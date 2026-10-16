/**
 * What a run's ledger already records, for a step that must not do twice what is done. The part
 * of softfac's `runner/progress.rs` the claim, the build and the gate need; later steps add what
 * they read.
 */

import { isState, type State } from "../domain/lifecycle.ts";
import type { Entry } from "../ledger/read.ts";

/** A passing attempt as the ledger records it: the commands that ran, and the commit they were gated on. */
export interface PassRecord {
  readonly attempt: number;
  /** The commit the commands ran on, in lower case. */
  readonly sha: string;
  /** The tip of the base branch the attempt ran against, from its `gate_checkout` line; empty when the ledger has none. */
  readonly baseSha: string;
  /** When the `gate-passed` step was written. */
  readonly atMs: number;
  /** Command, exit code and duration of each line of the attempt, in order. */
  readonly lines: ReadonlyArray<CommandLine>;
  /** How many of the last `lines` the marker says the passing run wrote. */
  readonly count: number;
}

/** One `gate_command` line. */
export interface CommandLine {
  readonly attempt: number;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

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
  /** A `pr_opened` since the run last entered `building` or had a gate sent back: the session's pull request waits for the gate. */
  readonly prReported: boolean;
  /** The ordinal in the newest `result-line-reminding` step: a reminder send was started. */
  readonly reminding: number | null;
  /** A `result-line-reminded` step: the session has had its one reminder. */
  readonly reminded: boolean;
  /**
   * The session is working until a run newer than this ordinal has ended: the reminder's, a
   * forward's or a gate send-back's wait marker. Never goes down. A send-back's marker is dropped
   * by the next `gate_command`, which shows the gate ran; a forward's only by a newer ended run.
   */
  readonly waitingAfter: number | null;
  /** The newest `session_paused` line: a person stopped the session's run in T3, and this is its ordinal. */
  readonly paused: { readonly runOrdinal: number | null } | null;
  /** Milliseconds spent in `triage` and `building` in stints that have ended. */
  readonly workedMs: number;
  /** When the stint that is running began; null when the run is not working. */
  readonly workingSince: number | null;
  /** The attempts that have a `gate_command` line. */
  readonly commandAttempts: ReadonlySet<number>;
  /** The attempts that were sent back into the session. */
  readonly sentBackAttempts: ReadonlySet<number>;
  /** The attempts whose `gate-passed` step is in the ledger and that were not sent back or checked out again after it. */
  readonly passedAttempts: ReadonlySet<number>;
  /** The `gate-passed <sha> <n>` step: the decision that the gate passed, made before the pull request was marked ready. */
  readonly pass: PassRecord | null;
  /** The newest `gate-sending` step: the attempt, and the ordinal of the session run it was gated on. */
  readonly sending: { readonly attempt: number; readonly runOrdinal: number } | null;
  /** A `gate-results-posted` step: the passing gate's results are on the pull request. */
  readonly resultsPosted: boolean;
  /** The directories a `gate_cleanup_failed` line already names. */
  readonly cleanupFailed: ReadonlySet<string>;
  /** How many `gate_regate` lines the run has since its last recorded pass. */
  readonly regates: number;
  /** A `pr_ready_outside` line: someone else marked the pull request ready while a gate ran, and it is noted. */
  readonly readyOutside: boolean;
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
/** The ledger step written before a failed attempt is sent: `gate-sending <attempt> <ordinal>`. */
export const GATE_SENDING = "gate-sending";
/** The ledger step that records the decision that an attempt passed: `gate-passed <sha> <n>`. */
export const GATE_PASSED = "gate-passed";
/** The ledger step that says the gate results are on the pull request. */
export const GATE_RESULTS_POSTED = "gate-results-posted";

const field = (data: unknown, key: string): unknown =>
  typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined;

/** `text` when it is a number without a sign or leading zero that is a safe integer. */
const canonical = (text: string): number | null =>
  /^(?:0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;

/** The `k` of a step written as `<name> <k>`, `k` a number without a sign or leading zero. */
const stepNumber = (step: string, name: string): number | null =>
  step.startsWith(`${name} `) ? canonical(step.slice(name.length + 1)) : null;

/** Whether `text` is a full commit id: 40 hex digits (64 in a SHA-256 repo). */
const isCommitId = (text: string): boolean => /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(text);

/** The `gate-sending <attempt> <ordinal>` step's numbers, or null for text that breaks the rules. */
export const parseGateSending = (
  step: string,
): { readonly attempt: number; readonly runOrdinal: number } | null => {
  if (!step.startsWith(`${GATE_SENDING} `)) return null;
  const parts = step.slice(GATE_SENDING.length + 1).split(" ");
  if (parts.length !== 2) return null;
  const attempt = canonical(parts[0]!);
  const runOrdinal = canonical(parts[1]!);
  return attempt === null || runOrdinal === null ? null : { attempt, runOrdinal };
};

/** The `gate-passed <sha> <n>` step's commit (lower case) and count, or null for text that breaks the rules. */
export const parseGatePassed = (
  step: string,
): { readonly sha: string; readonly count: number } | null => {
  if (!step.startsWith(`${GATE_PASSED} `)) return null;
  const parts = step.slice(GATE_PASSED.length + 1).split(" ");
  if (parts.length !== 2) return null;
  const [sha, count] = parts as [string, string];
  if (!isCommitId(sha)) return null;
  const n = canonical(count);
  return n === null || n === 0 ? null : { sha: sha.toLowerCase(), count: n };
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
  let waitIsForward = false;
  let paused: Seen["paused"] = null;
  let workedMs = 0;
  let workingSince: number | null = entries[0]?.ms ?? null;
  const commandAttempts = new Set<number>();
  const sentBackAttempts = new Set<number>();
  const passedAttempts = new Set<number>();
  let pass: PassRecord | null = null;
  /** The `gate_command` lines since the newest `gate_checkout`, newest last. */
  let commandRun: Array<CommandLine> = [];
  let lastCheckout: { readonly attempt: number; readonly baseSha: string } | null = null;
  let sending: Seen["sending"] = null;
  let resultsPosted = false;
  const cleanupFailed = new Set<string>();
  let regates = 0;
  let readyOutside = false;
  // A wait marker names run `k`: the awaited ordinal never goes down.
  const awaitRun = (k: number, forward: boolean) => {
    if (waitingAfter === null || k >= waitingAfter) {
      waitingAfter = k;
      waitIsForward = forward;
    }
  };
  const number = (value: unknown): number | null => (typeof value === "number" ? value : null);
  for (const entry of entries) {
    switch (entry.event) {
      case "claimed":
        claimed = true;
        break;
      case "step_changed": {
        const step = field(entry.data, "step");
        if (typeof step !== "string") break;
        if (approvedAt === null && step.startsWith("approved ")) {
          approvedAt = step.slice("approved ".length);
        }
        if (step === APPROVAL_RECHECKED) rechecked = true;
        if (step === RESULT_LINE_REMINDED) reminded = true;
        if (step === GATE_RESULTS_POSTED) resultsPosted = true;
        const remindingRun = stepNumber(step, RESULT_LINE_REMINDING);
        if (remindingRun !== null) {
          reminding = remindingRun;
          awaitRun(remindingRun, true);
        }
        const forwardRun = stepNumber(step, FORWARD_WAIT);
        if (forwardRun !== null) awaitRun(forwardRun, true);
        if (step === LAUNCH_SENDING || step.startsWith(`${LAUNCH_SENDING} resumed-from `)) {
          launchSent = true;
        }
        const gateSending = parseGateSending(step);
        if (gateSending !== null) sending = gateSending;
        const gatePassed = parseGatePassed(step);
        if (gatePassed !== null) {
          // The results of this pass are not posted yet, whatever an earlier one's were.
          resultsPosted = false;
          regates = 0;
          // The step's own cause names the attempt; a ledger from before it did is read by the
          // last command.
          const fromCause = entry.cause === null ? undefined : entry.cause.attempt;
          const attempt =
            typeof fromCause === "number" ? fromCause : (commandRun.at(-1)?.attempt ?? null);
          if (attempt !== null) {
            passedAttempts.add(attempt);
            const baseSha =
              lastCheckout !== null && lastCheckout.attempt === attempt ? lastCheckout.baseSha : "";
            pass = {
              attempt,
              sha: gatePassed.sha,
              baseSha,
              atMs: entry.ms,
              lines: commandRun.filter((line) => line.attempt === attempt),
              count: gatePassed.count,
            };
          }
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
          // A run that comes back to `building` has no pass: its gate failed again on a moved
          // base, and the session has to finish a new run for it to be decided.
          pass = null;
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
        waitIsForward = false;
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
      case "pr_ready_outside":
        readyOutside = true;
        break;
      case "session_paused": {
        const ordinal = field(entry.data, "run_ordinal");
        paused = { runOrdinal: typeof ordinal === "number" ? ordinal : null };
        break;
      }
      case "gate_checkout": {
        const attempt = number(field(entry.data, "attempt"));
        const baseSha = field(entry.data, "base_sha");
        if (attempt === null) break;
        // A new run of commands begins at its checkout: the attempt is open again.
        passedAttempts.delete(attempt);
        commandRun = [];
        lastCheckout = { attempt, baseSha: typeof baseSha === "string" ? baseSha : "" };
        break;
      }
      case "gate_command": {
        const attempt = number(field(entry.data, "attempt"));
        const command = field(entry.data, "command");
        const exitCode = number(field(entry.data, "exit_code"));
        const durationMs = number(field(entry.data, "duration_ms"));
        if (attempt === null) break;
        commandAttempts.add(attempt);
        if (!waitIsForward) waitingAfter = null;
        if (typeof command === "string" && exitCode !== null && durationMs !== null) {
          commandRun.push({ attempt, command, exitCode, durationMs });
        }
        break;
      }
      case "gate_sent_back": {
        const attempt = number(field(entry.data, "attempt"));
        const ordinal = number(field(entry.data, "run_ordinal"));
        if (attempt !== null) {
          sentBackAttempts.add(attempt);
          passedAttempts.delete(attempt);
        }
        if (ordinal !== null) awaitRun(ordinal, false);
        // A pass that was sent back is no pass: the session runs again and the head is gated afresh.
        pass = null;
        // The session is at work again: the run is a building run with no pull request reported
        // until the session reports it again, so it is time-limited, watched and read.
        prReported = false;
        break;
      }
      case "gate_regate":
        regates += 1;
        break;
      case "gate_cleanup_failed": {
        const dir = field(entry.data, "dir");
        if (typeof dir === "string") cleanupFailed.add(dir);
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
    commandAttempts,
    sentBackAttempts,
    passedAttempts,
    pass,
    sending,
    resultsPosted,
    cleanupFailed,
    regates,
    readyOutside,
  };
};

/**
 * The number of the gate attempt to make now: one more than the attempts so far, except that an
 * attempt with commands in the ledger that was never sent back and never passed died half way,
 * and is made again under the same number. A passed attempt is closed.
 */
export const nextGateAttempt = (seen: Seen): number => {
  const all = [...new Set([...seen.commandAttempts, ...seen.sentBackAttempts])].sort(
    (a, b) => a - b,
  );
  const last = all.at(-1);
  if (
    last !== undefined &&
    seen.commandAttempts.has(last) &&
    !seen.sentBackAttempts.has(last) &&
    !seen.passedAttempts.has(last)
  ) {
    return last;
  }
  return all.length + 1;
};

/**
 * How many attempts, `attempt` included, there have been since the last pass before it: the
 * attempts the retry budget counts.
 */
export const attemptsSincePass = (seen: Seen, attempt: number): number => {
  const before = [...seen.passedAttempts].filter((n) => n < attempt);
  const lastPass = before.length === 0 ? 0 : Math.max(...before);
  return attempt - lastPass;
};

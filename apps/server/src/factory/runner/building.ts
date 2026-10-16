/**
 * The steps that work a building run, ported from softfac's `runner/building.rs`: `advance`
 * reads how the session ended and moves the issue on, `watch` stops a run whose issue text was
 * changed by someone who is not an instructor, `forward` sends the session an instructor's
 * comments and edits of the issue body, `timeLimit` stops a run that took too long. The rest of
 * `building.rs` (interruptions and relaunches, review feedback, the notice for a dropped comment)
 * belongs to later issues; the gate itself is `gating.ts`. `advance` also ends a run whose pull request was merged
 * or closed, whose issue a person closed, or that an operator stopped by hand (#20).
 *
 * Each step reads the ledger first and does only what it does not record, so calling it again
 * resumes whatever an earlier call left half done. A failure of the tracker or of T3 is an
 * error, with nothing final written, and the next call decides again.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectConfig } from "../config.ts";
import { transition } from "../domain/lifecycle.ts";
import {
  NO_MESSAGE,
  NO_RESULT_LINE,
  SAID_STUCK,
  parseSessionResult,
  type SessionResult,
} from "../domain/resultLine.ts";
import { ledgerCall as ledger, type LedgerError } from "../ledger/errors.ts";
import { makeCause, type CauseStep, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readRun } from "../ledger/read.ts";
import { asciiLower, runIdToString, type RunId } from "../ledger/runId.ts";
import { formatTs } from "../ledger/time.ts";
import { isUtcSecond } from "../tracker/approvalHistory.ts";
import {
  GitHubParse,
  type Activity,
  type BoundGitHub,
  type IssueDetail,
  type PullRequest,
} from "../tracker/github.ts";
import {
  MessageRejectedError,
  ThreadNotFoundError,
  type FactorySessions,
  type RunStatus,
  type ThreadStatus,
} from "../t3/sessions.ts";
import {
  CANNOT_CONFIRM,
  CANNOT_VERIFY_DURING_BUILD,
  CHANGED_DURING_BUILD,
  RESULT_LINE_REMINDER,
  STOPPED_BY_HAND,
  THREAD_GONE,
  TIME_LIMIT,
  WRONG_ACCOUNT,
  WRONG_ACCOUNT_PREFIX,
  bodyEditMessage,
  commentMessage,
  prepareSessionText,
} from "./messages.ts";
import {
  BODY_EDIT_FORWARDED,
  FORWARD_WAIT,
  RESULT_LINE_REMINDED,
  RESULT_LINE_REMINDING,
  readProgress,
  type Seen,
} from "./progress.ts";
import {
  abandon,
  applyActions,
  closedIssue,
  describe,
  endOwnMerge,
  endRun,
  finishBuilding,
  goStuck,
  progressFrom,
  recordedReason,
  stopSession,
  type Progress,
  type RunContext,
  type RunError,
  type Stop,
} from "./run.ts";

/** What the steps of a building run ask of the factory: the run's repo and project, the tracker and the sessions. */
export interface BuildingContext extends RunContext {
  /** `owner/name` as the machine config writes it. */
  readonly repo: string;
  readonly project: ProjectConfig;
  readonly dataDir: string;
  readonly tracker: Pick<
    BoundGitHub,
    | "setState"
    | "assign"
    | "unassign"
    | "postComment"
    | "upsertStatusComment"
    | "pullRequest"
    | "markPrReady"
    | "markPrDraft"
    | "commentOnPr"
    | "textCheck"
    | "activitySince"
    | "issue"
    | "closedBy"
  >;
  readonly sessions: Pick<
    FactorySessions["Service"],
    "status" | "thread" | "send" | "archive" | "removeWorktree"
  >;
  /** Unix epoch milliseconds. */
  readonly clock: () => number;
}

const RunRef = Schema.Struct({ repo: Schema.String, issue: Schema.String, attempt: Schema.Number });

/** The run has a `finished` line: it is not a building run any more. */
export class NotBuildingError extends Schema.TaggedError<NotBuildingError>()("NotBuildingError", {
  run: RunRef,
}) {
  override get message(): string {
    return `run ${runIdToString(this.run)} is already finished`;
  }
}

/** The run has no `session_launched` line: there is no session to read. */
export class NoSessionError extends Schema.TaggedError<NoSessionError>()("NoSessionError", {
  run: RunRef,
}) {
  override get message(): string {
    return `run ${runIdToString(this.run)} has no launched session`;
  }
}

/** The run is another repo's. */
export class WrongRepoError extends Schema.TaggedError<WrongRepoError>()("WrongRepoError", {
  run: RunRef,
  repo: Schema.String,
}) {
  override get message(): string {
    return `run ${runIdToString(this.run)} is not a run of ${this.repo}`;
  }
}

export type BuildingError =
  | RunError
  | NotBuildingError
  | NoSessionError
  | WrongRepoError
  | ThreadNotFoundError
  | MessageRejectedError;

/** What `advance` did. */
export type AdvanceOutcome =
  /** The session is working, or the factory waits for a run it asked for. Nothing was decided. */
  | { readonly kind: "running" }
  /** The run ended with no result line and the one reminder was sent (or is waited for). */
  | { readonly kind: "reminded" }
  /** A person stopped the session's run in T3: nothing is sent and the issue is not touched. */
  | { readonly kind: "paused" }
  /**
   * The session's draft pull request is bound to the run and waits for the gate. Also what
   * `advance` says when the ledger already records that the gate passed and the move to
   * `pr-open` is not finished: the gate finishes it.
   */
  | { readonly kind: "ready-for-gate"; readonly pr: number; readonly prUrl: string }
  /** The gate passed and everything is written. The run stays open while its pull request waits for a person. */
  | { readonly kind: "passed"; readonly pr: number }
  /** The pull request was merged or closed, or it was merged and closed the issue: the run is finished. Nothing was written on GitHub. */
  | { readonly kind: "ended" }
  /** A person closed the issue: the session's thread is archived and the run is finished. Nothing was written on GitHub. */
  | { readonly kind: "abandoned" }
  /** The session asked its questions: they are on the issue and the run is ended. */
  | { readonly kind: "needs-info" }
  /** The issue went to `stuck`. `reason` is the one the ledger records. */
  | { readonly kind: "stuck"; readonly reason: string };

/** What `watch` did. */
export type WatchOutcome =
  /** The text is as the approval left it. Nothing was written. */
  | { readonly kind: "unchanged" }
  /** The run went to `stuck`. `reason` is the one the ledger records. */
  | { readonly kind: "stopped"; readonly reason: string }
  | {
      readonly kind: "skipped";
      readonly why: "finished" | "no-session" | "not-building" | "gate-passed" | "pr-merged";
    };

/** Why `forward` did nothing for a run. */
export type SkipReason =
  | "finished"
  | "no-session"
  | "not-building"
  /** A gate attempt is being sent into the session: a message sent now could be mistaken for the proof that it arrived. */
  | "gate-send-pending"
  /** A person closed the issue: the run is over. */
  | "abandoned"
  /** The run's own pull request was merged and closed the issue: `advance` ends it. */
  | "pr-merged"
  /** T3 no longer has the session's thread. */
  | "no-thread";

/** What `forward` did: how many comments and whether the edited body went into the session. */
export interface ForwardOutcome {
  readonly comments: number;
  readonly bodyEdit: boolean;
  readonly skipped: SkipReason | null;
}

/** What `timeLimit` did. */
export type LimitOutcome =
  | { readonly kind: "within" }
  /** The run went to `stuck`. `reason` is the one the ledger records. */
  | { readonly kind: "stopped"; readonly reason: string }
  | {
      readonly kind: "skipped";
      readonly why: "finished" | "not-running" | "launch-unrecorded" | "pr-reported" | "pr-merged";
    };

const MINUTE_MS = 60_000;

const issueOf = (run: RunId) => Number(run.issue);

const checkRepo = (ctx: BuildingContext, run: RunId) =>
  asciiLower(run.repo) === asciiLower(ctx.repo)
    ? Effect.void
    : Effect.fail(new WrongRepoError({ run, repo: ctx.repo }));

const readSeen = (ctx: BuildingContext, run: RunId) =>
  ledger(() => readRun(ctx.dataDir, run)).pipe(
    Effect.map((record) => readProgress(record.entries)),
  );

/** The run file, opened for append the first time a step writes to it and closed when the step ends. */
export interface Out {
  readonly open: Effect.Effect<Ledger, LedgerError>;
  readonly close: () => void;
}

export const lazyLedger = (ctx: BuildingContext, run: RunId): Out => {
  let handle: Ledger | null = null;
  return {
    open: ledger(() => (handle ??= Ledger.open(ctx.dataDir, run, { clock: ctx.clock }))),
    close: () => handle?.close(),
  };
};

export const withLedger = <A, E>(
  ctx: BuildingContext,
  run: RunId,
  body: (out: Out) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    const out = lazyLedger(ctx, run);
    return body(out).pipe(Effect.ensuring(Effect.sync(out.close)));
  });

export const append = (
  out: Out,
  event: RunEvent,
  step: CauseStep,
  reason: string,
  extras: { readonly attempt?: number; readonly command?: string } = {},
) =>
  Effect.flatMap(out.open, (opened) =>
    ledger(() => opened.append(event, makeCause(step, reason, extras))),
  );

/** A stop with the session's text, prepared once and left out when empty. */
export const stopOf = (
  reason: string,
  sessionText: string | null | undefined,
  extra: { readonly detail?: string } = {},
): Stop => {
  const prepared =
    sessionText === null || sessionText === undefined ? "" : prepareSessionText(sessionText);
  return {
    reason,
    ...(extra.detail !== undefined && { detail: extra.detail }),
    ...(prepared !== "" && { sessionText: prepared }),
  };
};

/** Whether a run status is one the run ended badly with: not completed, and not stopped by a person. */
const isEndedBadly = (status: RunStatus): boolean =>
  status === "failed" || status === "cancelled" || status === "rolled_back";

/** Whether a run status is one the run has finished with. An active status is not. */
export const isTerminal = (status: RunStatus): boolean =>
  status === "completed" || status === "interrupted" || isEndedBadly(status);

/**
 * Whether the session ended without any result line: no message, or a last line that is none of
 * the three. A malformed `FACTORY-DONE`, or questions with no questions, is not this: the
 * session did write a result line.
 */
const lacksResultLine = (result: SessionResult): boolean =>
  result.kind === "stuck" && (result.reason === NO_MESSAGE || result.reason === NO_RESULT_LINE);

/**
 * Whether the session is still working: its latest run must have ended, and after the factory
 * asked for a newer run (the reminder), that run must be a newer one than the run the marker
 * names. A newer run is enough, whichever message started it.
 */
export const sessionBusy = (seen: Seen, status: ThreadStatus): boolean => {
  const ended = status.run !== null && isTerminal(status.run);
  const newer =
    seen.waitingAfter === null ||
    (status.runOrdinal !== null && status.runOrdinal > seen.waitingAfter);
  return !ended || !newer;
};

/** Whether the first non-empty line of what a stuck session said is the one the launch message asks for. */
const saysWrongAccount = (sessionText: string | undefined): boolean => {
  if (sessionText === undefined) return false;
  const first = sessionText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  return first !== undefined && first.startsWith(WRONG_ACCOUNT_PREFIX);
};

const isThreadNotFound = Schema.is(ThreadNotFoundError);

/** The thread's status. A thread that is archived counts as one T3 no longer has: `null`. */
export const threadStatus = (
  ctx: BuildingContext,
  threadId: string,
): Effect.Effect<ThreadStatus | null, BuildingError> =>
  ctx.sessions.status(threadId).pipe(
    Effect.map((status) => (status.archived ? null : status)),
    Effect.catchIf(isThreadNotFound, () => Effect.succeed(null)),
  );

/** Why a pull request is not the session's own. `public` is one of the factory's fixed lines. */
export interface Unbound {
  /** What the comment says. */
  readonly public: string;
  /** Set when the public line must leave out something that came from the pull request: the ledger and the caller get this instead. */
  readonly detail?: string;
}

/**
 * Binds a pull request to a run: it exists, is in this repo and not a fork, merges into `base`,
 * and has as its head the session's own `branch`. The text came from a session that issue text
 * can steer, so it must not be able to name someone else's pull request. Whether it is a draft
 * is asked after, so only a bound one is ever put back to draft.
 */
export const checkBinding = (
  pull: PullRequest | null,
  pr: number,
  base: string,
  branch: string | null,
  mustBeDraft = false,
): Unbound | null => {
  const reported = `the session reported PR #${pr} but`;
  if (pull === null) return { public: `${reported} it does not exist` };
  if (pull.open && mustBeDraft && !pull.isDraft) return { public: `${reported} it is not a draft` };
  if (pull.crossRepository) return { public: `${reported} it comes from a fork` };
  if (pull.baseRef !== base) {
    return {
      public: `${reported} its base is not the configured base branch`,
      detail: `${reported} its base ${prepareSessionText(pull.baseRef)} is not the configured base branch`,
    };
  }
  if (branch === null) return { public: `${reported} the session has no branch` };
  if (pull.headRef !== branch) {
    return {
      public: `${reported} its branch is not this session's branch`,
      detail: `${reported} its branch ${prepareSessionText(pull.headRef)} is not this session's branch`,
    };
  }
  return null;
};

const stuckOutcome = (stop: Stop): AdvanceOutcome => ({
  kind: "stuck",
  reason: recordedReason(stop),
});

/**
 * Reads how the run's session ended and moves the issue on.
 *
 * While the run is active this writes nothing. Once it has ended, the last line of its last
 * message decides: a draft pull request that is open, on the session's own branch, is ready for
 * the gate; questions go on the issue and end the run; anything else sends the issue to `stuck`,
 * after the session's thread is archived (so a session that is still working stops with it; the
 * draft pull request, if any, is not touched).
 *
 * A run that ended on its own with no result line gets one fixed reminder before the factory
 * gives up: the session may have ended a turn while a subagent was still working. The step
 * `result-line-reminding <k>` (`k` is the run's ordinal) is written first. It records that a
 * send is owed and is the wait marker too: the session counts as working until a run newer than
 * `k` has ended. Then the message is sent under `softfac:<run>:remind:<k>`, then
 * `result-line-reminded` is written. A run that ended as failed, interrupted or cancelled, a run
 * with no ordinal, and a result line that is present but unusable get no reminder.
 *
 * Calling `advance` again resumes whatever an earlier call or `start` left half done, judging by
 * the ledger: a launch whose `building` label is missing gets it (once `start` has looked at the
 * issue text again after the launch; until then `advance` reports `running` and leaves it to
 * `start`), a stuck decision already in the ledger is carried out without asking T3 and without
 * a second comment, and questions already posted are not posted again. A run whose
 * `state_changed` to `needs-info` is written has nothing left on GitHub: the thread is archived,
 * the worktree removed and the run finished. Comments are at-least-once; everything else
 * happens once.
 *
 * A pull request that was merged or closed ends the run (`ended`): the thread is archived and the
 * run finished with `pr_end`, with nothing written on GitHub; for a run in `pr-open` that is all
 * `advance` does. An issue a person closed ends it too (`abandoned`), as does the run's own merged
 * pull request closing it, unless a gate pass is recorded, which the gate finishes. An operator's
 * stop (`stop_requested`) sends the run to `stuck` as stopped by hand, whatever the session is
 * doing and without reading it.
 */
export const advance = (
  ctx: BuildingContext,
  run: RunId,
): Effect.Effect<AdvanceOutcome, BuildingError> =>
  withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      yield* checkRepo(ctx, run);
      const seen = yield* readSeen(ctx, run);
      if (seen.finished) return yield* new NotBuildingError({ run });
      const issue = issueOf(run);
      // Before anything is decided or written: a closed issue is a person's move, or the run's
      // own merged pull request, which ends the run here unless a recorded pass has the gate
      // finish it.
      const { closing, detail } = yield* closedIssue(ctx, run, seen);
      if (closing.kind === "persons-move") {
        yield* abandon(ctx, yield* out.open, run, seen, "advance");
        return { kind: "abandoned" } as const;
      }
      if (closing.kind === "own-merge" && seen.pass === null) {
        yield* endOwnMerge(ctx, yield* out.open, run, seen, "advance", closing.pull);
        return { kind: "ended" } as const;
      }
      const at = progressFrom("advance", seen, "triage");
      const stuck = (code: string, stop: Stop) =>
        Effect.gen(function* () {
          const opened = yield* out.open;
          yield* goStuck(ctx, issue, opened, at, code, stop);
          return stuckOutcome(stop);
        });
      // A stuck decision an older version recorded for a run it left in `needs-info` is not
      // carried out: that run is ended below and the issue stays `needs-info`.
      if (seen.stuck !== null && at.state !== "needs-info") {
        return yield* stuck("stuck-resumed", { reason: seen.stuck });
      }
      // `stop-run.sh` ended the run on purpose. The thread is archived, or found gone, by the
      // stuck path and its status is never read: whatever the session is doing, the run goes
      // `stuck` as stopped by hand.
      // Only a building run: a line that is there for a run past `building` is stale.
      if (seen.stopRequested && at.state === "building") {
        return yield* stuck("stop-requested", { reason: STOPPED_BY_HAND });
      }
      const threadId = seen.threadId;
      if (threadId === null) return yield* new NoSessionError({ run });
      // `state_changed` is the commit marker: a run in `needs-info` has had every write done, and
      // a person may have changed the issue since, so it is ended and nothing is written on GitHub.
      if (at.state === "needs-info") {
        yield* releaseOldClaim(ctx, issue, detail);
        yield* endNeedsInfo(ctx, out, at);
        return { kind: "needs-info" } as const;
      }
      // Every write is done: the run stays open while its pull request waits for a person, and
      // ends when a person merges or closes it (or it is gone).
      if (at.state === "pr-open" && seen.lastPr !== null) {
        const pull = yield* ctx.tracker.pullRequest(seen.lastPr.pr);
        if (pull === null || !pull.open) {
          yield* endRun(ctx, yield* out.open, at, seen.lastPr.url, pull, "advance");
          return { kind: "ended" } as const;
        }
        return { kind: "passed", pr: seen.lastPr.pr } as const;
      }
      // The gate passed and died before the move to `pr-open` was finished: the gate finishes
      // it, and nothing here looks at the session or the pull request again.
      if (seen.pass !== null && seen.lastPr !== null) {
        return { kind: "ready-for-gate", pr: seen.lastPr.pr, prUrl: seen.lastPr.url } as const;
      }
      if (at.state === "triage") {
        // `start` looks at the issue text again after the launch. A launch it has not done that
        // for is left to it, so this cannot give the run its `building` label around the check.
        if (!seen.rechecked) return { kind: "running" } as const;
        yield* finishBuilding(ctx, issue, yield* out.open, at);
      }

      // A thread T3 no longer has is a stop.
      const status = yield* threadStatus(ctx, threadId);
      if (status === null) return yield* stuck("thread-gone", stopOf(THREAD_GONE, null));
      const message = status.lastAssistantMessage;
      const result = parseSessionResult(ctx.repo, message ?? undefined);
      // Sends the reminder for run `k`; a thread T3 no longer has, or a refusal, ends the run.
      const remind = (k: number) =>
        Effect.gen(function* () {
          const sent = yield* sendReminder(ctx, out, run, threadId, k);
          if (sent === "gone") return yield* stuck("thread-gone", stopOf(THREAD_GONE, null));
          if (sent !== "sent") {
            return yield* stuck("session-stuck", refusedStop(result, message, sent));
          }
          return { kind: "reminded" } as const;
        });

      // A `result-line-reminding <k>` step with no `result-line-reminded` is a reminder cut short
      // before its send or its step. If a run newer than `k` exists the send reached the session
      // and the step is only written; otherwise the send is made again, under the same command id.
      let alreadyReminded = seen.reminded;
      if (seen.reminding !== null && !alreadyReminded) {
        if (status.runOrdinal !== null && status.runOrdinal > seen.reminding) {
          yield* append(out, remindedStep, "advance", "result-line-reminded");
          alreadyReminded = true;
        } else {
          return yield* remind(seen.reminding);
        }
      }
      // The reminder is owed once per run: the latest run, which has an ordinal, ended with
      // no result line, and none was sent. A run with no ordinal cannot be waited for, so it is
      // read as it always was. Paused and ended-badly runs return below, before this is read.
      const owed =
        !alreadyReminded &&
        lacksResultLine(result) &&
        status.runOrdinal !== null &&
        status.run !== null &&
        isTerminal(status.run);
      if (sessionBusy(seen, status)) return { kind: "running" } as const;
      // A run a person stopped in T3 is paused, on purpose: nothing is sent to resume it and the
      // issue is not touched.
      if (status.run === "interrupted" && result.kind !== "done") {
        if (seen.paused === null || seen.paused.runOrdinal !== status.runOrdinal) {
          yield* append(
            out,
            { event: "session_paused", data: { run_ordinal: status.runOrdinal } },
            "advance",
            "session-paused",
          );
        }
        return { kind: "paused" } as const;
      }
      if (status.run !== null && result.kind !== "done" && isEndedBadly(status.run)) {
        return yield* stuck(
          "session-ended-badly",
          stopOf(`the session run ended as ${status.run}`, message),
        );
      }
      if (owed && status.runOrdinal !== null) {
        yield* append(
          out,
          {
            event: "step_changed",
            data: { step: `${RESULT_LINE_REMINDING} ${status.runOrdinal}` },
          },
          "advance",
          "result-line-reminding",
        );
        return yield* remind(status.runOrdinal);
      }

      switch (result.kind) {
        case "done": {
          const { pr, prUrl } = result;
          const pull = yield* ctx.tracker.pullRequest(pr);
          const unbound = checkBinding(pull, pr, ctx.project.base, status.branch);
          if (unbound !== null) {
            return yield* stuck(
              "pr-not-bound",
              stopOf(
                unbound.public,
                message,
                unbound.detail === undefined ? {} : { detail: unbound.detail },
              ),
            );
          }
          // The session's pull request that is open and ready for review goes back to draft:
          // only the gate marks it ready. A call that fails leaves it as it is, and stuck.
          if (pull !== null && pull.open && !pull.isDraft) {
            const drafted = yield* Effect.result(ctx.tracker.markPrDraft(pr));
            if (drafted._tag === "Failure") {
              // A rate limit says nothing about the pull request: ask again next pass.
              if (drafted.failure._tag === "GitHubRateLimited") return yield* drafted.failure;
              return yield* stuck(
                "pr-not-bound",
                stopOf(`the session reported PR #${pr} but it is not a draft`, message),
              );
            }
            yield* append(out, { event: "pr_set_draft", data: { pr } }, "advance", "pr-set-draft");
          }
          if (!seen.opened.includes(pr)) {
            yield* append(
              out,
              { event: "pr_opened", data: { pr, url: prUrl } },
              "advance",
              "pr-opened",
            );
          }
          // A pull request a person merged or closed before the gate looked at it ends the run:
          // nothing is left to gate.
          if (pull !== null && !pull.open) {
            yield* endRun(ctx, yield* out.open, at, prUrl, pull, "advance");
            return { kind: "ended" } as const;
          }
          return { kind: "ready-for-gate", pr, prUrl } as const;
        }
        case "needs-info": {
          const prepared = prepareSessionText(result.questions);
          const raised = yield* Effect.fromResult(
            transition(at.state, { kind: "questions-raised", questions: prepared }),
          );
          yield* applyActions(
            ctx,
            issue,
            yield* out.open,
            at,
            raised.actions,
            makeCause("advance", "questions-asked"),
          );
          yield* endNeedsInfo(ctx, out, at);
          return { kind: "needs-info" } as const;
        }
        case "stuck": {
          if (result.reason === SAID_STUCK && saysWrongAccount(result.sessionText)) {
            return yield* stuck("session-wrong-account", stopOf(WRONG_ACCOUNT, result.sessionText));
          }
          return yield* stuck("session-stuck", stopOf(result.reason, result.sessionText));
        }
      }
    }),
  );

const remindedStep: RunEvent = { event: "step_changed", data: { step: RESULT_LINE_REMINDED } };

/**
 * Gives back an issue that an older version's `answer` claimed for a run now left in
 * `needs-info`: that step set `factory:building` and assigned the machine's user before it wrote
 * its `state_changed` marker, so a crash between the two leaves the issue claimed with no
 * unfinished run. Only that exact shape is touched: the label is `factory:building` and the
 * machine's user is the only assignee. Any other label or assignee is a person's, and is left
 * alone. Both calls are safe to repeat. `read` is the issue as this step already read it, if it did.
 */
const releaseOldClaim = (ctx: BuildingContext, issue: number, read: IssueDetail | null) =>
  Effect.gen(function* () {
    const detail = read ?? (yield* ctx.tracker.issue(issue));
    const ours =
      detail.assignees.length === 1 &&
      asciiLower(detail.assignees[0]!) === asciiLower(ctx.trackerUser);
    if (detail.state === "building" && ours) {
      yield* ctx.tracker.setState(issue, "needs-info");
      yield* ctx.tracker.unassign(issue, ctx.trackerUser);
    }
  });

/**
 * Ends a run whose questions are on the issue: the thread is archived, its worktree is removed,
 * and the ledger is finished as `needs-info`. Nothing is written on GitHub: the questions, the
 * label and the release were done before `state_changed`, which is what says so. An archive that
 * fails is an error with nothing written, so the next call ends the run.
 */
const endNeedsInfo = (ctx: BuildingContext, out: Out, at: Progress) =>
  Effect.gen(function* () {
    const opened = yield* out.open;
    yield* stopSession(ctx, opened, at);
    yield* ledger(() =>
      opened.finish("needs-info", null, null, makeCause("advance", "questions-asked")),
    );
  });

/**
 * Sends the session its one reminder to end with a result line, and records that it was sent.
 * `k` is the ordinal of the run that ended without one, and the command id is
 * `softfac:<run>:remind:<k>`: a send repeated after a crash is the same command, and a lost step
 * that meets a newer run with no result line is a new one for that run, so the worst case is a
 * second reminder and never a hang. The caller has written `result-line-reminding <k>`, which is
 * also the wait marker; `result-line-reminded` is written last. T3 not having the thread is
 * `"gone"`. A refusal is final, since T3 keeps it under the command id and a resend would fail
 * the same way: it is returned for the caller to end the run with.
 */
const sendReminder = (
  ctx: BuildingContext,
  out: Out,
  run: RunId,
  threadId: string,
  k: number,
): Effect.Effect<"sent" | "gone" | MessageRejectedError, BuildingError> =>
  Effect.gen(function* () {
    const sent = yield* ctx.sessions
      .send(threadId, `softfac:${runIdToString(run)}:remind:${k}`, RESULT_LINE_REMINDER)
      .pipe(
        Effect.as("sent" as const),
        Effect.catchIf(isThreadNotFound, () => Effect.succeed("gone" as const)),
        Effect.catchIf(isMessageRejected, (refused) => Effect.succeed(refused)),
      );
    if (sent !== "sent") return sent;
    yield* append(out, remindedStep, "advance", "result-line-reminded");
    return sent;
  });

const isMessageRejected = Schema.is(MessageRejectedError);

/**
 * The stop for a reminder T3 refused: the public reason is the run's own (it ended with no result
 * line, or no message), the ledger's detail says the reminder could not reach it.
 */
const refusedStop = (
  result: SessionResult,
  message: string | null,
  refused: MessageRejectedError,
): Stop => {
  const reason =
    result.kind === "stuck" && lacksResultLine(result) ? result.reason : NO_RESULT_LINE;
  return stopOf(reason, message, {
    detail: `${reason}; T3 refused the reminder: ${describe(refused)}`,
  });
};

/**
 * Why the issue text no longer stands for a building run, or `null` when it does. A run with no
 * `approved` step has no moment to read since, so it fails closed without a read; otherwise the
 * histories of every rename and body edit since the recorded approval must be an instructor's.
 * A history that cannot be judged counts as changed. A read that fails is an error, never an
 * answer.
 */
export const textStop = (
  ctx: BuildingContext,
  issue: number,
  seen: Seen,
): Effect.Effect<{ readonly code: string; readonly reason: string } | null, BuildingError> =>
  Effect.gen(function* () {
    if (seen.approvedAt === null) return { code: "approval-unconfirmed", reason: CANNOT_CONFIRM };
    const check = yield* ctx.tracker.textCheck(issue, seen.approvedAt, ctx.project.instructors);
    switch (check) {
      case "unchanged":
        return null;
      case "changed":
        return { code: "text-changed-during-build", reason: CHANGED_DURING_BUILD };
      case "unjudged":
        return { code: "edits-unverifiable", reason: CANNOT_VERIFY_DURING_BUILD };
    }
  });

/**
 * Stops a building run whose issue text was changed by someone who is not an instructor, or whose
 * history of edits cannot be judged. The session's thread is archived first, then the run goes
 * `stuck` through the stuck path (the draft pull request, if any, is not touched).
 *
 * A read that fails is an error, never a stop and never a pass. Nothing is written when the text
 * is unchanged, and no step records that a check passed: the text is read again on every call,
 * since an edit can come at any time. An archive that fails is an error with nothing written, so
 * the next call decides and archives again.
 *
 * A run that is finished, has no session, is not `building`, or has a stuck or questions
 * decision not yet committed makes no call (`skipped`: `advance` finishes those). A run of
 * another repo is an error. There is no loop or timer: the caller decides how often to call it,
 * and it should call `watch` before `advance` on a `building` run.
 */
export const watch = (
  ctx: BuildingContext,
  run: RunId,
): Effect.Effect<WatchOutcome, BuildingError> =>
  Effect.gen(function* () {
    yield* checkRepo(ctx, run);
    const seen = yield* readSeen(ctx, run);
    if (seen.finished) return { kind: "skipped", why: "finished" } as const;
    if (seen.threadId === null) return { kind: "skipped", why: "no-session" } as const;
    if (
      seen.state !== "building" ||
      seen.stuck !== null ||
      seen.stopRequested ||
      seen.questionsPosted
    ) {
      return { kind: "skipped", why: "not-building" } as const;
    }
    // The gate checks the text itself before it records a pass, and after one the session is done.
    if (seen.pass !== null) return { kind: "skipped", why: "gate-passed" } as const;
    const issue = issueOf(run);
    const why = yield* textStop(ctx, issue, seen);
    if (why === null) return { kind: "unchanged" } as const;
    // Only a run that has reported a pull request can have been closed by its own merge: no read
    // for any other. `advance` ends that run; a closed issue otherwise changes nothing here.
    if (seen.opened.length > 0) {
      const { closing } = yield* closedIssue(ctx, run, seen);
      if (closing.kind === "own-merge") return { kind: "skipped", why: "pr-merged" } as const;
    }
    const at = progressFrom("watch", seen, "building");
    const stop: Stop = { reason: why.reason };
    yield* withLedger(ctx, run, (out) =>
      Effect.flatMap(out.open, (opened) => goStuck(ctx, issue, opened, at, why.code, stop)),
    );
    return { kind: "stopped", reason: recordedReason(stop) } as const;
  });

/**
 * A gate attempt was being sent into the session (a `gate-sending` step with no matching
 * `gate_sent_back`), so a message sent now could be mistaken for the proof that it arrived.
 */
export const gateSendPending = (seen: Seen): boolean =>
  seen.sending !== null && !seen.sentBackAttempts.has(seen.sending.attempt);

/**
 * The `since` of every read of an issue's activity for a run: the run's first ledger line, cut
 * to whole seconds, never a moving cursor. The milliseconds are cut off, not rounded, so `since`
 * may be early, never late.
 */
const sinceRunStart = (firstMs: number): string => `${formatTs(firstMs).slice(0, 19)}Z`;

/**
 * What `forward` still has to send from one read of the instructors' activity: the comments the
 * ledger has no `comment_forwarded` for, oldest first and each id once, and the body edit whose
 * time has no `body-edit-forwarded` step. A body edit time that is not GitHub's form is refused
 * before anything is sent or written: it ends up in the ledger and in a command id.
 */
const unsent = (seen: Seen, activity: Activity) =>
  Effect.gen(function* () {
    const edit = activity.bodyEdit;
    if (edit !== null && !isUtcSecond(edit.editedAt)) {
      return yield* new GitHubParse({
        args: ["api", "graphql"],
        expected: `the body edit time as YYYY-MM-DDTHH:MM:SSZ, got "${Array.from(edit.editedAt).slice(0, 40).join("").replaceAll("\n", "\\n")}"`,
      });
    }
    const told = new Set(seen.forwarded);
    const comments = activity.comments.filter((comment) => {
      if (told.has(comment.id)) return false;
      told.add(comment.id);
      return true;
    });
    return {
      comments,
      bodyEdit: edit !== null && !seen.bodyEdits.has(edit.editedAt) ? edit : null,
    };
  });

/**
 * Sends the session the instructors' new comments and their edit of the issue body, once each.
 * Activity is read from the run's first ledger line on (`sinceRunStart`), never from a moving
 * cursor, and what the ledger already holds (`comment_forwarded` by comment id, the
 * `body-edit-forwarded <edited_at>` step) is not sent again, so every call is safe to repeat. The
 * comments go in oldest first, then the edit, which may be the same text the comments came
 * after. A comment goes under the command id `softfac:<run>:comment:<id>` and then
 * `comment_forwarded` is written; an edit under `softfac:<run>:body:<edited_at>`, then its step.
 * A send that fails fails the call: what was sent stays recorded and the rest goes in on the next
 * call under the same ids.
 *
 * A session that is idle (its latest run ended, or it has none) starts a new run when it gets a
 * message, so `forward-wait <k>` (`k` the ordinal of the run that ended) is written before the
 * first send: the session counts as working until a run newer than `k` has ended, and `advance`
 * and the gate wait for it instead of judging the old run again. A session that is working has
 * the message steered into its run, which needs no marker. The status is read only when there is
 * something to send.
 *
 * `forward` changes no state, and it has no loop or timer: the caller decides how often to call
 * it, and should not gate in a pass where it sent something. A run that is finished, has no
 * session, is not `building` (or has a gate pass, a stuck or questions decision not yet
 * committed, or a stop by hand), or whose gate send is pending makes no call (`skipped`). A
 * closed issue ends the run, as for `advance`, when a person closed it (`abandoned`: the thread
 * is archived, the ledger finished, nothing written on GitHub); the run's own merge is left to
 * `advance`. A thread T3 no longer has is `no-thread`. A run of another repo is an error.
 */
export const forward = (
  ctx: BuildingContext,
  run: RunId,
): Effect.Effect<ForwardOutcome, BuildingError> =>
  withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      yield* checkRepo(ctx, run);
      const record = yield* ledger(() => readRun(ctx.dataDir, run));
      const seen = readProgress(record.entries);
      const skip = (skipped: SkipReason): ForwardOutcome => ({
        comments: 0,
        bodyEdit: false,
        skipped,
      });
      if (seen.finished) return skip("finished");
      const first = record.entries[0];
      const threadId = seen.threadId;
      if (threadId === null || first === undefined) return skip("no-session");
      // `state_changed` is the commit marker, so a stuck decision or posted questions without it
      // are a transition that was cut short. A recorded gate pass is not interrupted.
      if (
        seen.state !== "building" ||
        seen.pass !== null ||
        seen.stuck !== null ||
        seen.stopRequested ||
        seen.questionsPosted
      ) {
        return skip("not-building");
      }
      // The gate infers that a send-back reached the session from a newer run having ended. A
      // run that a forwarded message starts would count too, and burn the attempt, so the
      // message waits until the gate has sent the failure and recorded it.
      if (gateSendPending(seen)) return skip("gate-send-pending");
      // Only a run that would read the issue's activity asks whether the issue is closed. A run
      // whose own merge closed the issue gets nothing more sent; `advance` ends it.
      const { closing } = yield* closedIssue(ctx, run, seen);
      if (closing.kind === "persons-move") {
        yield* abandon(ctx, yield* out.open, run, seen, "forward");
        return skip("abandoned");
      }
      if (closing.kind === "own-merge") return skip("pr-merged");

      const issue = Number(run.issue);
      const activity = yield* ctx.tracker.activitySince(
        issue,
        sinceRunStart(first.ms),
        ctx.project.instructors,
      );
      const { comments, bodyEdit } = yield* unsent(seen, activity);
      if (comments.length === 0 && bodyEdit === null) {
        return { comments: 0, bodyEdit: false, skipped: null };
      }

      // Something is to be sent: is the session idle? A message sent into an ended run starts a
      // new run, and the gate must wait for that run, not judge the old one again.
      const status = yield* threadStatus(ctx, threadId);
      if (status === null) return skip("no-thread");
      if (status.run === null || isTerminal(status.run)) {
        const k = status.runOrdinal ?? 0;
        if (seen.lastWait !== k) {
          yield* append(
            out,
            { event: "step_changed", data: { step: `${FORWARD_WAIT} ${k}` } },
            "forward",
            "forward-waiting",
          );
        }
      }
      const opened = yield* out.open;
      const at = progressFrom("forward", seen, "building");
      const runName = runIdToString(run);
      for (const comment of comments) {
        const { actions } = yield* Effect.fromResult(
          transition("building", { kind: "instructor-commented", commentId: comment.id }),
        );
        yield* applyActions(
          ctx,
          issue,
          opened,
          at,
          actions,
          makeCause("forward", "comment-forwarded"),
          {
            forward: {
              commandId: `softfac:${runName}:comment:${comment.id}`,
              text: commentMessage(ctx.repo, issue, comment.author, comment.body),
            },
          },
        );
      }
      // The edit goes after the comments of this call, which may have been written before it.
      if (bodyEdit !== null) {
        const { actions } = yield* Effect.fromResult(
          transition("building", { kind: "body-edited" }),
        );
        yield* applyActions(
          ctx,
          issue,
          opened,
          at,
          actions,
          makeCause("forward", "body-edit-forwarded"),
          {
            forward: {
              commandId: `softfac:${runName}:body:${bodyEdit.editedAt}`,
              text: bodyEditMessage(ctx.repo, issue, bodyEdit.editor, bodyEdit.body),
              step: `${BODY_EDIT_FORWARDED} ${bodyEdit.editedAt}`,
            },
          },
        );
      }
      return { comments: comments.length, bodyEdit: bodyEdit !== null, skipped: null };
    }),
  );

/** The branch the thread works on, or `undefined` when it has none or T3 cannot say: a read that fails is not a stop. */
const branchOf = (ctx: BuildingContext, threadId: string): Effect.Effect<string | undefined> =>
  ctx.sessions.thread(threadId).pipe(
    Effect.map((thread) => thread.branch ?? undefined),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Stops a run that has worked for longer than `limits.minutes`.
 *
 * The time counted is what the run spent in `triage` and `building`, from the ledger: the time a
 * ready pull request waited in `pr-open` is left out (such a run is not limited at all). A run
 * past the limit has its session's thread read for its branch and then archived (archiving a
 * thread whose run is active stops that run), then goes `stuck` through the stuck path with the
 * fixed reason `the run passed its time limit`, released and finished. When the thread has a
 * branch, the stuck line and the comment name it; a thread that cannot be read, or has no branch,
 * changes nothing. A run still in `triage` that never sent a launch has nothing to archive.
 *
 * A run that is finished, past `building`, in `needs-info`, or has a stuck or questions decision
 * not yet committed is skipped. So is a run whose session reported its pull request since it
 * last entered `building` (`pr-reported`): the session's work is done and waits for the gate, and
 * that wait is not the build's time. So is a run whose launch was sent with no session recorded
 * (`launch-unrecorded`): the session may be running, and only `resume` can name it, so the call
 * after `resume` stops it with its thread. A run of another repo is an error. There is no loop or
 * timer: the caller decides how often to call it, and it should call it first for a run in
 * `triage` or `building`, and skip the run's other steps when it stops.
 */
export const timeLimit = (
  ctx: BuildingContext,
  run: RunId,
): Effect.Effect<LimitOutcome, BuildingError> =>
  Effect.gen(function* () {
    yield* checkRepo(ctx, run);
    const seen = yield* readSeen(ctx, run);
    if (seen.finished) return { kind: "skipped", why: "finished" } as const;
    const working =
      seen.state === null ||
      seen.state === "ready" ||
      seen.state === "triage" ||
      seen.state === "building";
    if (!working || seen.stuck !== null || seen.stopRequested || seen.questionsPosted) {
      return { kind: "skipped", why: "not-running" } as const;
    }
    if (seen.prReported) return { kind: "skipped", why: "pr-reported" } as const;
    if (seen.threadId === null && seen.launchSent) {
      return { kind: "skipped", why: "launch-unrecorded" } as const;
    }
    const worked =
      seen.workedMs +
      (seen.workingSince === null ? 0 : Math.max(0, ctx.clock() - seen.workingSince));
    if (worked <= ctx.project.limits.minutes * MINUTE_MS) return { kind: "within" } as const;
    // Only a run that has reported a pull request can have been closed by its own merge: no read
    // for any other.
    if (seen.opened.length > 0) {
      const { closing } = yield* closedIssue(ctx, run, seen);
      if (closing.kind === "own-merge") return { kind: "skipped", why: "pr-merged" } as const;
    }
    // Read before the archive: the next attempt is told where the work is.
    const branch = seen.threadId === null ? undefined : yield* branchOf(ctx, seen.threadId);
    const prepared = branch === undefined ? "" : prepareSessionText(branch);
    const stop: Stop = {
      reason: TIME_LIMIT,
      ...(prepared !== "" && { branch: prepared, commitsAhead: null }),
    };
    // Called by the pass before any step, so the pass is what decided.
    const at = progressFrom("pass", seen, "triage");
    yield* withLedger(ctx, run, (out) =>
      Effect.flatMap(out.open, (opened) =>
        goStuck(ctx, issueOf(run), opened, at, "time-limit", stop),
      ),
    );
    return { kind: "stopped", reason: recordedReason(stop) } as const;
  });

/**
 * What every step that stops or finishes a run shares, ported from softfac's `runner.rs`: the
 * stuck path with its session stop, the move to `factory:building`, and the three ways a run ends
 * without a gate: its pull request was merged or closed (`endRun`), its issue was closed
 * (`abandon`), or an operator stopped it by hand (the stuck path). Each step passes its own
 * `Progress.step`, which names it in the ledger's causes.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { InvalidTransition, transition, type Action, type State } from "../domain/lifecycle.ts";
import { ledgerCall as ledger, type LedgerError } from "../ledger/errors.ts";
import { makeCause, type Cause, type CauseStep } from "../ledger/events.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { RunId } from "../ledger/runId.ts";
import type { BoundGitHub, GitHubError, IssueDetail, PullRequest } from "../tracker/github.ts";
import { ThreadNotFoundError } from "../t3/sessions.ts";
import type { FactorySessions, MessageRejectedError, SessionsError } from "../t3/sessions.ts";
import { questionsComment, statusBody, stuckComment, type WorkLeft } from "./messages.ts";
import { GATE_RESULTS_POSTED, type Seen } from "./progress.ts";

/** What the stop, finish and gate-action paths can fail with. */
export type RunError =
  | GitHubError
  | LedgerError
  | InvalidTransition
  | SessionsError
  | ThreadNotFoundError
  | MessageRejectedError;

/** What the stop and finish paths call: the tracker and the sessions, whichever step runs them. */
export interface RunContext {
  readonly trackerUser: string;
  readonly machine: string;
  /** The base branch: the work a stop leaves is counted against it. */
  readonly project: { readonly base: string };
  readonly tracker: Pick<
    BoundGitHub,
    | "setState"
    | "assign"
    | "unassign"
    | "postComment"
    | "upsertStatusComment"
    | "markPrReady"
    | "markPrDraft"
    | "commentOnPr"
    | "issue"
    | "pullRequest"
    | "closedBy"
  >;
  readonly sessions: Pick<
    FactorySessions["Service"],
    "archive" | "thread" | "removeWorktree" | "send"
  >;
}

/**
 * Where the issue stands while the stuck actions are applied. `threadId`, `worktree` and
 * `worktreeDone` start from the ledger and move as this call launches and stops the session.
 */
export interface Progress {
  /** The step running, for the cause of every line written here. */
  readonly step: CauseStep;
  state: State;
  threadId: string | null;
  worktree: string | null;
  worktreeDone: boolean;
  /** The run's newest pull request, for the status comment; none when absent. */
  readonly pr: number | null;
  /** Why the run is stopping, set by `goStuck` for the stuck comment; none otherwise. */
  stop: Stop | null;
  /** What the ledger said when the step began: the comment-once guards read it. */
  readonly seen: Seen;
  /** The ledger already says the gate results are on the pull request. */
  gateResultsPosted: boolean;
}

/**
 * What a forwarded comment or body edit carries that the ledger does not: the message, under a
 * command id so a retry is the same command, and for a body edit the `body-edit-forwarded <edited_at>`
 * step that records it. An action whose part is missing is an `InvalidTransition`.
 */
export interface ForwardPayload {
  readonly commandId: string;
  readonly text: string;
  readonly step?: string;
}

/**
 * What the gate's and the forwards' actions carry that the ledger does not: the results comment
 * `post-gate-results` posts, and the send `send-gate-failure` makes, under a command id so a
 * retry is the same command, with the attempt and session run ordinal it then records as sent
 * back. An action whose part is missing is an `InvalidTransition`.
 */
export interface GatePayload {
  /** What `forward-comment` and `forward-body-edit` send. */
  readonly forward?: ForwardPayload;
  readonly comment?: string;
  readonly send?: {
    readonly commandId: string;
    readonly attempt: number;
    readonly runOrdinal: number;
  };
}

/** Where the issue stands, from what the ledger says. `fallback` is the state of a run that has none yet. */
export const progressFrom = (step: CauseStep, seen: Seen, fallback: State): Progress => ({
  step,
  state: seen.state ?? fallback,
  threadId: seen.threadId,
  worktree: seen.worktree,
  worktreeDone: seen.worktreeDone,
  pr: seen.lastPr?.pr ?? null,
  stop: null,
  seen,
  gateResultsPosted: seen.resultsPosted,
});

/** The words for what a failed call said: its message when it has one. */
export const describe = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "message" in cause &&
  typeof cause.message === "string"
    ? cause.message
    : String(cause);

/** The label, the status comment and the ledger line that follow a launch. Safe to repeat. */
export const finishBuilding = (
  ctx: RunContext,
  issue: number,
  out: Ledger,
  at: Progress,
): Effect.Effect<void, RunError> =>
  Effect.gen(function* () {
    const building = yield* Effect.fromResult(transition(at.state, { kind: "session-starting" }));
    yield* applyActions(
      ctx,
      issue,
      out,
      at,
      building.actions,
      makeCause(at.step, "session-started"),
    );
  });

/**
 * Carries out the actions a transition asks for, in order, as softfac's `apply` does. The label,
 * the release and the status comment are repeated safely; the two comments are posted once, as
 * `at.seen` says (the questions, and the stuck decision, which `at.stop` words). The
 * `state_changed` line is written last, after every action, so a ledger that still shows the old
 * state means the transition may be unfinished and is run again. `cause` is the cause of every
 * line written. The gate's actions: marking the pull request ready is repeated safely, its
 * results comment (`gate.comment`) is posted once (`at.gateResultsPosted`, the
 * `gate-results-posted` step), and a failure is sent under `gate.send.commandId` and then
 * recorded as sent back for that attempt and run. A forwarded comment or body edit is sent under
 * `gate.forward.commandId` and then recorded (`comment_forwarded`, or the step
 * `gate.forward.step`). Actions that belong to later steps, and gate or forward actions with no
 * payload, are an `InvalidTransition`.
 */
export const applyActions = (
  ctx: RunContext,
  issue: number,
  out: Ledger,
  at: Progress,
  actions: ReadonlyArray<Action>,
  cause: Cause,
  gate: GatePayload = {},
): Effect.Effect<void, RunError> =>
  Effect.gen(function* () {
    let movedTo: State | undefined;
    for (const action of actions) {
      switch (action.kind) {
        case "launch-session":
          // Launched already.
          break;
        case "post-questions":
          if (!at.seen.questionsPosted) {
            yield* ctx.tracker.postComment(issue, questionsComment(action.questions));
            yield* ledger(() =>
              out.append(
                { event: "questions_posted", data: { questions: action.questions } },
                cause,
              ),
            );
          }
          break;
        case "post-stuck-comment":
          if (at.seen.stuck === null) {
            // The lifecycle's reason is the recorded one and may hold detail the public must not
            // read, so without a stop the comment says only this.
            const stop = at.stop;
            const work: WorkLeft | undefined =
              stop?.branch === undefined
                ? undefined
                : {
                    branch: stop.branch,
                    commitsAhead: stop.commitsAhead ?? null,
                    base: ctx.project.base,
                  };
            yield* ctx.tracker.postComment(
              issue,
              stop === null
                ? stuckComment("the factory stopped this run")
                : stuckComment(stop.reason, stop.sessionText, work),
            );
            yield* ledger(() =>
              out.append(
                {
                  event: "stuck",
                  data: {
                    reason: action.reason,
                    ...(work !== undefined && { branch: work.branch }),
                    ...(work?.commitsAhead != null && { commits_ahead: work.commitsAhead }),
                  },
                },
                cause,
              ),
            );
          }
          break;
        case "set-label":
          yield* ctx.tracker.setState(issue, action.state);
          movedTo = action.state;
          break;
        case "assign-to-machine":
          yield* ctx.tracker.assign(issue, ctx.trackerUser);
          break;
        case "unassign":
          yield* ctx.tracker.unassign(issue, ctx.trackerUser);
          break;
        case "mark-pr-draft":
          yield* ctx.tracker.markPrDraft(action.pr);
          break;
        case "mark-pr-ready":
          yield* ctx.tracker.markPrReady(action.pr);
          break;
        case "post-gate-results": {
          if (at.gateResultsPosted) break;
          const body = gate.comment;
          if (body === undefined) {
            return yield* new InvalidTransition({ state: at.state, event: action.kind });
          }
          yield* ctx.tracker.commentOnPr(action.pr, body);
          yield* ledger(() =>
            out.append(
              { event: "step_changed", data: { step: GATE_RESULTS_POSTED } },
              makeCause(at.step, "gate-results-posted"),
            ),
          );
          at.gateResultsPosted = true;
          break;
        }
        case "send-gate-failure": {
          const send = gate.send;
          if (at.threadId === null || send === undefined) {
            return yield* new InvalidTransition({ state: at.state, event: action.kind });
          }
          // The command id is the run's and the attempt's, so a send repeated after a crash is
          // the same command.
          yield* ctx.sessions.send(at.threadId, send.commandId, action.output);
          yield* ledger(() =>
            out.append(
              {
                event: "gate_sent_back",
                data: { attempt: send.attempt, run_ordinal: send.runOrdinal },
              },
              makeCause(at.step, cause.reason, { attempt: send.attempt }),
            ),
          );
          break;
        }
        case "forward-comment": {
          const send = gate.forward;
          if (at.threadId === null || send === undefined) {
            return yield* new InvalidTransition({ state: at.state, event: action.kind });
          }
          yield* ctx.sessions.send(at.threadId, send.commandId, send.text);
          yield* ledger(() =>
            out.append(
              { event: "comment_forwarded", data: { comment_id: action.commentId } },
              cause,
            ),
          );
          break;
        }
        case "forward-body-edit": {
          const send = gate.forward;
          if (at.threadId === null || send?.step === undefined) {
            return yield* new InvalidTransition({ state: at.state, event: action.kind });
          }
          const recorded = send.step;
          yield* ctx.sessions.send(at.threadId, send.commandId, send.text);
          yield* ledger(() =>
            out.append({ event: "step_changed", data: { step: recorded } }, cause),
          );
          break;
        }
        case "update-status-comment":
          yield* ctx.tracker.upsertStatusComment(
            issue,
            ctx.trackerUser,
            statusBody(movedTo ?? at.state, ctx.machine, at.threadId, at.pr),
          );
          break;
        default:
          return yield* new InvalidTransition({ state: at.state, event: action.kind });
      }
    }
    if (movedTo !== undefined && movedTo !== at.state) {
      const from = at.state;
      yield* ledger(() =>
        out.append({ event: "state_changed", data: { from, to: movedTo } }, cause),
      );
      at.state = movedTo;
    }
  });

/**
 * Stops the session before the run goes stuck: archives the thread, then removes its worktree
 * unless the ledger says that is done. An archive or a read of the thread that fails fails the
 * start with nothing written, and the next pass archives again. A worktree that cannot be
 * removed is written down and does not stop the run.
 */
export const stopSession = (
  ctx: RunContext,
  out: Ledger,
  at: Progress,
): Effect.Effect<void, RunError> =>
  Effect.gen(function* () {
    if (at.threadId === null) return;
    yield* ctx.sessions.archive(at.threadId);
    if (at.worktreeDone) return;
    const reported = yield* ctx.sessions.thread(at.threadId).pipe(
      Effect.map((thread) => thread.worktreePath),
      Effect.catchIf(isThreadNotFound, () => Effect.succeed(null)),
    );
    const path = reported ?? at.worktree;
    if (path !== null) {
      const removed = yield* Effect.result(ctx.sessions.removeWorktree(path));
      if (removed._tag === "Success") {
        yield* ledger(() =>
          out.append(
            { event: "worktree_removed", data: { path } },
            makeCause(at.step, "worktree-removed"),
          ),
        );
      } else {
        yield* ledger(() =>
          out.append(
            {
              event: "worktree_remove_failed",
              data: { path, error: describe(removed.failure.cause) },
            },
            makeCause(at.step, "worktree-remove-failed"),
          ),
        );
      }
    }
    at.worktreeDone = true;
  });

const isThreadNotFound = Schema.is(ThreadNotFoundError);

/**
 * Why a run goes stuck. `reason` is the public one: one of the factory's own fixed lines, the only
 * text that goes in the comment's `Reason:`. `detail`, when there is one, holds what the public
 * must not read (a T3 error, a branch name) and stays in the ledger and the caller's reason.
 * `sessionText` is what the session said and `branch` where its work is, both already through
 * `prepareSessionText` and left out when empty.
 */
export interface Stop {
  readonly reason: string;
  readonly detail?: string;
  readonly sessionText?: string;
  readonly branch?: string;
  readonly commitsAhead?: number | null;
}

/** The reason as the ledger stores it and the caller gets it: the factory's words, then the session's. */
export const recordedReason = (stop: Stop): string =>
  (stop.detail ?? stop.reason) + (stop.sessionText === undefined ? "" : `\n\n${stop.sessionText}`);

/**
 * The stuck path. The session is stopped first (see `stopSession`), so a failure of that leaves
 * the issue as it was and the next pass tries again. Then the actions `lifecycle.transition`
 * asks for on a failure, in order, then the `state_changed` line and the summary line. The
 * comment says `stop.reason`, quotes `stop.sessionText` and names `stop.branch`; the ledger's
 * `stuck` line says `stop.detail` when there is one, then the session text, and the branch. A
 * comment is skipped when the ledger already records it; the label, the release and the status
 * comment are repeated safely. `code` is the reason of every line it writes.
 */
export const goStuck = (
  ctx: RunContext,
  issue: number,
  out: Ledger,
  at: Progress,
  code: string,
  stop: Stop,
): Effect.Effect<void, RunError> =>
  Effect.gen(function* () {
    const cause = makeCause(at.step, code);
    if (at.state === "stuck") {
      yield* ledger(() => out.finish("stuck", null, null, cause));
      return;
    }
    yield* stopSession(ctx, out, at);
    const failed = yield* Effect.fromResult(
      transition(at.state, { kind: "failed", reason: recordedReason(stop) }),
    );
    at.stop = stop;
    yield* applyActions(ctx, issue, out, at, failed.actions, cause);
    yield* ledger(() => out.finish("stuck", null, null, cause));
  });

/**
 * Ends a run whose pull request was merged or closed, from `pr-open` or, for the session's own
 * pull request that a person ended before the gate could mark it ready, from `building`. Nothing
 * will use its session again, so the thread is archived first (an error other than T3 not having
 * the thread is returned with nothing written, and the next call archives again; a run whose
 * ledger never got a thread has nothing to archive); then the summary line, the only write,
 * caused by `step`. Nothing is posted on GitHub. A pull request that is gone, or closed without a
 * merge, was closed.
 */
export const endRun = (
  ctx: RunContext,
  out: Ledger,
  at: Progress,
  prUrl: string,
  pull: PullRequest | null,
  step: CauseStep,
): Effect.Effect<void, RunError> =>
  Effect.gen(function* () {
    yield* stopSession(ctx, out, at);
    const prEnd = pull !== null && pull.merged ? "merged" : "closed";
    yield* ledger(() =>
      out.finish("pr-open", null, prUrl, makeCause(step, "pull-request-ended"), prEnd),
    );
  });

/** What a closed issue means for a run. */
export type Closing =
  /** The issue is open, or the run has nothing left to write and was not asked. */
  | { readonly kind: "open" }
  /** A person closed it: a move, and the run is abandoned. */
  | { readonly kind: "persons-move" }
  /** The run's own pull request was merged, which closed the issue. The pull request as GitHub shows it. */
  | { readonly kind: "own-merge"; readonly pull: PullRequest };

const OPEN: Closing = { kind: "open" };

/**
 * Whether a closed issue is a person's move for this run, or the run's own finish. It is the run's
 * own when a pull request the run reported (`pr_opened` lines) is merged, whether or not the gate
 * had passed: with a pass recorded the gate completes it without writing on the pull request;
 * before one, the step that finds it ends the run with `pr_end: merged` at once. A pull request
 * the run has not reported yet cannot be known here, so a merge before the first `advance` after
 * the session's report still reads as a person's move. `closed` is what GitHub says about the
 * issue. A read that fails is an error, never an answer.
 */
export const movedOnByClosing = (
  ctx: RunContext,
  seen: Seen,
  closed: boolean,
): Effect.Effect<Closing, RunError> =>
  Effect.gen(function* () {
    if (!closed) return OPEN;
    for (const pr of seen.opened) {
      const pull = yield* ctx.tracker.pullRequest(pr);
      if (pull !== null && pull.merged) return { kind: "own-merge", pull } as const;
    }
    return { kind: "persons-move" } as const;
  });

/**
 * What the run's issue being closed means for it, with the issue as read for that (`detail`, null
 * when it was not read), so a caller that needs the issue too does not read it again. A run that
 * has nothing left to write (`pr-open`, `stuck`) asks nothing of GitHub, and neither does a step
 * that would skip the run (the caller checks that first).
 */
export const closedIssue = (
  ctx: RunContext,
  run: RunId,
  seen: Seen,
): Effect.Effect<{ readonly closing: Closing; readonly detail: IssueDetail | null }, RunError> =>
  Effect.gen(function* () {
    if (seen.state === "pr-open" || seen.state === "stuck") return { closing: OPEN, detail: null };
    const detail = yield* ctx.tracker.issue(Number(run.issue));
    return { closing: yield* movedOnByClosing(ctx, seen, detail.closed), detail };
  });

/**
 * Finishes a run whose issue a person closed: the session's thread is archived first (an archive
 * error other than T3 not having the thread is an error with nothing written, so the next call
 * decides again), then the ledger is finished, as `needs-info` for a run that was left in that
 * state and as `stuck` for any other. Nothing is written on GitHub: the person owns the issue now.
 *
 * The summary line says which step noticed, with the login of the person who closed the issue
 * when GitHub says whose it was. The login is a courtesy: a read that fails ends the run the same.
 *
 * True when a session may exist that this could not archive: a launch was sent and the ledger
 * never got its thread, so the caller says so (the launch command id is `softfac:<run>:launch`).
 */
export const abandon = (
  ctx: RunContext,
  out: Ledger,
  run: RunId,
  seen: Seen,
  step: CauseStep,
): Effect.Effect<boolean, RunError> =>
  Effect.gen(function* () {
    yield* stopSession(ctx, out, progressFrom(step, seen, "triage"));
    const actor = yield* ctx.tracker
      .closedBy(Number(run.issue))
      .pipe(Effect.orElseSucceed(() => null));
    const cause = makeCause(step, "issue-closed", actor === null ? {} : { actor });
    const outcome = seen.state === "needs-info" ? "needs-info" : "stuck";
    yield* ledger(() => out.finish(outcome, null, null, cause));
    return seen.launchSent && seen.threadId === null;
  });

/**
 * Ends a run whose own merged pull request closed its issue before a gate pass was recorded:
 * `endRun` with the URL the session wrote for that pull request (or the one GitHub would give it,
 * for a pull request the ledger holds under another number). `step` is the step that found it.
 */
export const endOwnMerge = (
  ctx: RunContext,
  out: Ledger,
  run: RunId,
  seen: Seen,
  step: CauseStep,
  pull: PullRequest,
): Effect.Effect<void, RunError> => {
  const url =
    seen.lastPr !== null && seen.lastPr.pr === pull.number
      ? seen.lastPr.url
      : `https://github.com/${run.repo}/pull/${pull.number}`;
  return endRun(ctx, out, progressFrom(step, seen, "triage"), url, pull, step);
};

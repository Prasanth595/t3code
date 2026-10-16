/**
 * What every step that stops or finishes a run shares, ported from softfac's `runner.rs`: the
 * stuck path with its session stop, and the move to `factory:building`. Each step passes its own
 * `Progress.step`, which names it in the ledger's causes.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { InvalidTransition, transition, type Action, type State } from "../domain/lifecycle.ts";
import { ledgerCall as ledger, type LedgerError } from "../ledger/errors.ts";
import { makeCause, type Cause, type CauseStep } from "../ledger/events.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { BoundGitHub, GitHubError } from "../tracker/github.ts";
import { ThreadNotFoundError } from "../t3/sessions.ts";
import type { FactorySessions, SessionsError } from "../t3/sessions.ts";
import { questionsComment, statusBody, stuckComment, type WorkLeft } from "./messages.ts";
import type { Seen } from "./progress.ts";

/** What the stop and finish paths can fail with. */
export type RunError = GitHubError | LedgerError | InvalidTransition | SessionsError;

/** What the stop and finish paths call: the tracker and the sessions, whichever step runs them. */
export interface RunContext {
  readonly trackerUser: string;
  readonly machine: string;
  /** The base branch: the work a stop leaves is counted against it. */
  readonly project: { readonly base: string };
  readonly tracker: Pick<
    BoundGitHub,
    "setState" | "unassign" | "postComment" | "upsertStatusComment"
  >;
  readonly sessions: Pick<FactorySessions["Service"], "archive" | "thread" | "removeWorktree">;
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
 * line written. Actions that belong to later steps are an `InvalidTransition`.
 */
export const applyActions = (
  ctx: RunContext,
  issue: number,
  out: Ledger,
  at: Progress,
  actions: ReadonlyArray<Action>,
  cause: Cause,
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
        case "unassign":
          yield* ctx.tracker.unassign(issue, ctx.trackerUser);
          break;
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

/**
 * What every step that stops or finishes a run shares, ported from softfac's `runner.rs`: the
 * stuck path with its session stop, and the move to `factory:building`. Each step passes its own
 * `Progress.step`, which names it in the ledger's causes.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { InvalidTransition, transition, type State } from "../domain/lifecycle.ts";
import { ledgerCall as ledger, type LedgerError } from "../ledger/errors.ts";
import { makeCause, type CauseStep } from "../ledger/events.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { BoundGitHub, GitHubError } from "../tracker/github.ts";
import { ThreadNotFoundError } from "../t3/sessions.ts";
import type { FactorySessions, SessionsError } from "../t3/sessions.ts";
import { statusBody, stuckComment } from "./messages.ts";
import type { Seen } from "./progress.ts";

/** What the stop and finish paths can fail with. */
export type RunError = GitHubError | LedgerError | InvalidTransition | SessionsError;

/** What the stop and finish paths call: the tracker and the sessions, whichever step runs them. */
export interface RunContext {
  readonly trackerUser: string;
  readonly machine: string;
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
  readonly seen: Seen;
}

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
  threadId: string,
): Effect.Effect<void, RunError> =>
  Effect.gen(function* () {
    const building = yield* Effect.fromResult(transition(at.state, { kind: "session-starting" }));
    for (const action of building.actions) {
      switch (action.kind) {
        case "set-label":
          yield* ctx.tracker.setState(issue, action.state);
          break;
        case "launch-session":
          // Launched already.
          break;
        case "update-status-comment":
          yield* ctx.tracker.upsertStatusComment(
            issue,
            ctx.trackerUser,
            statusBody("building", ctx.machine, threadId, null),
          );
          break;
        default:
          return yield* new InvalidTransition({ state: at.state, event: "session-starting" });
      }
    }
    yield* ledger(() =>
      out.append(
        { event: "state_changed", data: { from: at.state, to: building.next } },
        makeCause(at.step, "session-started"),
      ),
    );
    at.state = building.next;
  });

/**
 * Stops the session before the run goes stuck: archives the thread, then removes its worktree
 * unless the ledger says that is done. An archive or a read of the thread that fails fails the
 * start with nothing written, and the next pass archives again. A worktree that cannot be
 * removed is written down and does not stop the run.
 */
const stopSession = (ctx: RunContext, out: Ledger, at: Progress): Effect.Effect<void, RunError> =>
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

/** Why a run goes stuck: `reason` is the public one; `detail`, when there is one, stays in the ledger. */
export interface Stop {
  readonly reason: string;
  readonly detail?: string;
}

/**
 * The stuck path. The session is stopped first (see `stopSession`), so a failure of that leaves
 * the issue as it was and the next pass tries again. Then the actions `lifecycle.transition`
 * asks for on a failure, in order, then the `state_changed` line and the summary line. The
 * comment says `stop.reason`; the ledger's `stuck` line says `stop.detail` when there is one. A
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
    const recorded = stop.detail ?? stop.reason;
    const failed = yield* Effect.fromResult(
      transition(at.state, { kind: "failed", reason: recorded }),
    );
    let movedTo: State | null = null;
    let stuckPosted = at.seen.stuck !== null;
    for (const action of failed.actions) {
      switch (action.kind) {
        case "post-stuck-comment":
          if (!stuckPosted) {
            yield* ctx.tracker.postComment(issue, stuckComment(stop.reason));
            yield* ledger(() => out.append({ event: "stuck", data: { reason: recorded } }, cause));
            stuckPosted = true;
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
            statusBody(movedTo ?? at.state, ctx.machine, at.threadId, null),
          );
          break;
        default:
          return yield* new InvalidTransition({ state: at.state, event: "failed" });
      }
    }
    yield* ledger(() =>
      out.append({ event: "state_changed", data: { from: at.state, to: failed.next } }, cause),
    );
    yield* ledger(() => out.finish("stuck", null, null, cause));
  });

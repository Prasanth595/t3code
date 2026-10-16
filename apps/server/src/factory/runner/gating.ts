/**
 * The gate of a building run, ported from softfac's `runner/gating.rs` `gate`: a fresh checkout
 * of the pull request's head merged with the base tip, the project's commands in it, and the
 * decision that follows; and `regate`, the same gate for a `pr-open` pull request whose head or
 * base moved since its last pass. Required checks (#26) belong to a later issue. The checkout,
 * the commands and the removal are `FactoryGate`'s
 * (`gate.ts`), which also writes the attempt's `gate_checkout` and `gate_command` lines; this
 * module decides what they mean.
 *
 * Each call reads the ledger first and does only what it does not record, so calling it again
 * resumes whatever an earlier call left half done. A failure of the tracker, of T3 or of the
 * checkout is an error, with nothing final written, and the next call decides again.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { transition, type Action } from "../domain/lifecycle.ts";
import {
  WorkspaceUnexpectedError,
  commandCode,
  gateResultsComment,
  gateRoot,
  leftoverCheckouts,
  regateResultsComment,
  removeEmptyGateRoot,
  removeLeftoverCheckouts,
  type CommandResult,
  type FactoryGate,
  type GateError,
  type GateOptions,
} from "../gate.ts";
import { ledgerCall as ledger, type LedgerError } from "../ledger/errors.ts";
import { makeCause } from "../ledger/events.ts";
import { readRun } from "../ledger/read.ts";
import { asciiLower, runIdToString, type RunId } from "../ledger/runId.ts";
import type { FactorySessions, Model, ThreadStatus } from "../t3/sessions.ts";
import { isCommitId, sanitize } from "../text.ts";
import type { BoundGitHub, IssueDetail } from "../tracker/github.ts";
import {
  WrongRepoError,
  append,
  checkBinding,
  sessionBusy,
  stopOf,
  textStop,
  threadStatus,
  withLedger,
  type BuildingContext,
  type BuildingError,
  type Out,
} from "./building.ts";
import {
  BASE_KEPT_MOVING,
  END_WITH_DONE,
  STOPPED_BY_HAND,
  THREAD_GONE,
  failureMessage,
  howItEnded,
  mergeConflictMessage,
  prepareOutputTail,
} from "./messages.ts";
import {
  GATE_PASSED,
  GATE_SENDING,
  attemptsSincePass,
  movedSince,
  nextGateAttempt,
  pendingRelaunch,
  readProgress,
  regateAttempt,
  type Moved,
  type PassRecord,
  type Relaunch,
  type Seen,
} from "./progress.ts";
import { branchRefused, relaunchSession } from "./relaunch.ts";
import {
  abandon,
  applyActions,
  closedIssue,
  endOwnMerge,
  endRun,
  goStuck,
  progressFrom,
  recordedReason,
  stopSession,
  type Progress,
  type Stop,
} from "./run.ts";

export { mergeConflictMessage } from "./messages.ts";
export { movedSince, type Moved } from "./progress.ts";

/**
 * What the gate asks of the factory besides what a building run asks: the base tip, who marked a
 * pull request ready, the gate itself, and what a failed re-gate needs to launch the session that
 * fixes it.
 */
export interface GateContext extends BuildingContext {
  readonly tracker: BuildingContext["tracker"] & Pick<BoundGitHub, "branchTip" | "readyBy">;
  readonly gate: Pick<FactoryGate["Service"], "run">;
  readonly maxConcurrentGates: number;
  readonly gateOptions?: GateOptions;
  readonly repoPath: string;
  readonly ghConfigDir: string;
  readonly model: Model;
  readonly sessions: BuildingContext["sessions"] &
    Pick<FactorySessions["Service"], "findProject" | "launch">;
}

/** The project names no gate command: nothing can pass, and the pass marker could not tell a gate command from a provision command. */
export class NoGateCommandsError extends Schema.TaggedError<NoGateCommandsError>()(
  "NoGateCommandsError",
  { repo: Schema.String },
) {
  override get message(): string {
    return `${this.repo}: the project config names no gate command`;
  }
}

export type GateStepError = BuildingError | GateError | NoGateCommandsError;

/** What `gate` did. */
export type GateStep =
  /**
   * Every command passed. The pull request is ready for review, the results are on it and the
   * issue is `pr-open`. The run is not finished: it stays open while its pull request waits for
   * a person.
   */
  | { readonly kind: "passed"; readonly pr: number }
  /** An attempt failed and was sent into the session. `advance` reports the run ready for the gate again only after the session has finished a new run. */
  | { readonly kind: "sent-back"; readonly attempt: number }
  /** The issue went to `stuck`. The pull request stays open, a draft. `reason` is as the ledger records it. */
  | { readonly kind: "stuck"; readonly reason: string }
  /**
   * Nothing to gate yet, or any more: the run is finished, has no pull request or session, is not
   * `building`, or its session is still working. Also the answer when the pull request's head
   * moved while the commands ran: the next call gates the new head. Nothing was decided, though a
   * gate run that did happen is on record.
   */
  | { readonly kind: "not-ready" }
  /** The pull request was merged or closed, so the run is finished and is never looked at again. A pass on the commit that was merged is recorded and moves the issue to `pr-open` first. */
  | { readonly kind: "ended" }
  /** A person closed the issue: the session's thread is archived and the run is finished, with no command run and nothing written on GitHub. */
  | { readonly kind: "abandoned" }
  /** This run has a gate running already: its lock is held. */
  | { readonly kind: "running" }
  /**
   * Only `regate` says this: the pull request's head and the base branch's tip are the ones the
   * last pass ran against, so there is nothing to gate again. Two reads were made and nothing was
   * written.
   */
  | { readonly kind: "unchanged" }
  /** `max_concurrent_gates` gates run already; the next call tries again. */
  | { readonly kind: "queued"; readonly running: number; readonly max: number };

const NOT_READY = { kind: "not-ready" } as const;

/** `attempt` as the stuck comment counts it: "1 attempt", "2 attempts". */
const attempts = (n: number): string => `${n} ${n === 1 ? "attempt" : "attempts"}`;

/** The results of a pass, as the comment needs them: the last `count` command lines of the attempt. */
const resultsOf = (pass: PassRecord): ReadonlyArray<CommandResult> =>
  pass.lines.slice(Math.max(0, pass.lines.length - pass.count)).map((line) => ({
    command: line.command,
    exitCode: line.exitCode,
    durationMs: line.durationMs,
    timedOut: false,
    output: "",
  }));

/** The gate's stuck path: `goStuck` with the gate as the step, and the reason as the ledger records it. */
const stuckWith = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  code: string,
  stop: Stop,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const opened = yield* out.open;
    yield* goStuck(ctx, issue, opened, at, code, stop);
    return { kind: "stuck", reason: recordedReason(stop) } as const;
  });

/**
 * The rest of a passing gate once the pass is recorded: stop the session and remove its
 * worktree (the branch stays, locally and on `origin`), mark the pull request ready, post the
 * results (each skipped when the ledger says it is done), move the issue to `pr-open` and write
 * the `state_changed` line. The run is not finished: it stays open while its pull request waits
 * for a person. `stillOpen` is false for a pull request that was merged or closed in the
 * meantime: nothing is posted on it, and the issue still moves on.
 *
 * The stop comes first, before any write on GitHub, so a call cut short after it finds the
 * thread archived and the worktree line written, and does neither again.
 */
const finishPass = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  pass: PassRecord,
  pr: number,
  stillOpen: boolean,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const opened = yield* out.open;
    yield* stopSession(ctx, opened, at);
    const moved = yield* Effect.fromResult(transition("building", { kind: "pr-ready", pr }));
    const actions = moved.actions.filter(
      (action) =>
        stillOpen || (action.kind !== "mark-pr-ready" && action.kind !== "post-gate-results"),
    );
    const comment = gateResultsComment(resultsOf(pass), pass.attempt, pass.sha, pass.baseSha);
    yield* applyActions(ctx, issue, opened, at, actions, makeCause("gate", "gate-passed"), {
      comment,
    });
    return { kind: "passed", pr } as const;
  });

/**
 * Runs the project's provision and gate commands in a fresh checkout of the pull request's head
 * and decides, from their exit codes and nobody's word, whether the build passed. Call it with a
 * run that `advance` reported as ready for the gate.
 *
 * `ctx.project` must be the config the caller loaded from the base branch. The commands are never
 * read from the checkout: a pull request could otherwise edit its own gate.
 *
 * First the session is read (a thread T3 no longer has is a stop) and the pull request is bound
 * to the run again (it may have changed since `advance`; one that is open must be a draft). A
 * pull request a person merged or closed ends the run with nothing gated. Then the tip of the
 * base branch is read and `FactoryGate` makes the checkout, under `<dataDir>/gate/<run>/<n>`:
 * the head and that tip fetched by their ids, the head checked out and the tip merged into it.
 * The commands run on the merged tree, so a branch that passes alone and breaks once the base
 * has moved does not pass. A merge conflict is a failed attempt with no command run, told to the
 * session in fixed words. The ledger gets where the gate ran and on which commits, then each
 * command's result.
 *
 * All passed: the pull request is read again (it must still be the session's own and at the
 * commit that was gated; a head that moved is no pass and no failure, and the next call gates
 * the new head; one closed without a merge ends the run; one merged has its pass recorded and
 * ends the run with nothing posted), then the base tip (one that moved sends the gate round
 * again on the new merge, up to `limits.regates` times since the last pass, then `stuck`), then
 * the issue text as `watch` judges it. Then the ledger gets `gate-passed <sha> <n>` before
 * anything is marked ready, and `finishPass` does the rest. Calling `gate` again after an error
 * resumes: with that step in the ledger nothing is run again and only the transition is
 * finished, `state_changed` is the commit marker and is written last, a posted results comment
 * is skipped when the ledger records it, and marking the pull request ready is safe to repeat.
 * An attempt that died before the step is run again under the same number.
 *
 * A failure (a command, a provision command or a conflict) puts a pull request someone else took
 * out of draft back to draft, then goes into the session with `END_WITH_DONE` in front, under the
 * command id `softfac:<run>:gate:<attempt>:<ordinal>`, with the `gate-sending` step before the
 * send and `gate_sent_back` after it. `gate_retries` failures since the last pass may go back;
 * the one after that goes `stuck` with `the gate failed after <n> attempts` and the output in
 * the comment (a conflict's paths stay in the ledger).
 *
 * Before any of that, a closed issue ends the run: a person's move is `abandoned` (the thread is
 * archived, the run finished, nothing written on GitHub, no command run), and the run's own
 * merged pull request closing it is `ended` unless a pass is recorded, which the rest of the
 * gate finishes. A run an operator stopped by hand goes `stuck` as stopped by hand, with no
 * checkout and no command.
 */
export const gate = (ctx: GateContext, run: RunId): Effect.Effect<GateStep, GateStepError> =>
  withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      if (asciiLower(run.repo) !== asciiLower(ctx.repo)) {
        return yield* new WrongRepoError({ run, repo: ctx.repo });
      }
      const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
      const threadId = seen.threadId;
      const last = seen.lastPr;
      if (threadId === null || last === null || seen.finished) return NOT_READY;
      const issue = Number(run.issue);
      // Before anything is decided or written: a closed issue is a person's move, or the run's
      // own merged pull request, which ends the run here unless a recorded pass finishes it below.
      const { closing } = yield* closedIssue(ctx, run, seen);
      if (closing.kind === "persons-move") {
        yield* abandon(ctx, yield* out.open, run, seen, "gate");
        return { kind: "abandoned" } as const;
      }
      if (closing.kind === "own-merge" && seen.pass === null) {
        yield* endOwnMerge(ctx, yield* out.open, run, seen, "gate", closing.pull);
        return { kind: "ended" } as const;
      }
      const at = progressFrom("gate", seen, "triage");
      // A decision to give up that is already in the ledger stands, and is carried out without
      // asking T3 or git anything.
      if (seen.stuck !== null) {
        return yield* stuckWith(ctx, out, issue, at, "stuck-resumed", { reason: seen.stuck });
      }
      // `stop-run.sh` ended the run: no attempt starts, and the run goes `stuck` as stopped by
      // hand, its thread archived first.
      if (seen.stopRequested && at.state === "building") {
        return yield* stuckWith(ctx, out, issue, at, "stop-requested", { reason: STOPPED_BY_HAND });
      }
      // Every write is done: the run stays open while its pull request waits for a person.
      if (at.state === "pr-open") return { kind: "passed", pr: last.pr } as const;
      if (at.state !== "building") return NOT_READY;
      // The gate already passed: what is left is the rest of the transition. No checkout is
      // made, no command is run, and neither the session nor the pull request's binding is
      // looked at again; a pull request that is no longer open gets nothing posted on it.
      if (seen.pass !== null) {
        const pull = yield* ctx.tracker.pullRequest(last.pr);
        const stillOpen = pull !== null && pull.open;
        return yield* finishPass(ctx, out, issue, at, seen.pass, last.pr, stillOpen);
      }
      return yield* gateAttempts(ctx, out, run, seen, at, {
        threadId,
        pr: last.pr,
        prUrl: last.url,
        ready: false,
        regates: seen.regates,
      });
    }),
  );

/**
 * The gate's runs on one pull request, from the session read to the decision: the attempts, the
 * base branch moving between them, and what follows a pass or a failure. `gate` and `regate` call
 * it once they know what they are gating. `ready` is a pull request that passed the gate and
 * waits for a person (`regate`): it has no session to wait for or to send a failure to, any
 * branch is its own, a merged or closed pull request ends the run, and a failure starts a new
 * session instead.
 */
const gateAttempts = (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  gating: {
    readonly threadId: string | null;
    readonly pr: number;
    readonly prUrl: string;
    readonly ready: boolean;
    readonly regates: number;
  },
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const { threadId, pr, prUrl, ready } = gating;
    const issue = Number(run.issue);
    const stuck = (code: string, stop: Stop) => stuckWith(ctx, out, issue, at, code, stop);

    // The thread, which the gate of a building run reads first, to wait for the session. A
    // re-gate of a ready pull request does not depend on the session, which has been stopped
    // since the pass: a failure starts a new one.
    let status: ThreadStatus | null = null;
    if (!ready) {
      status = yield* threadStatus(ctx, threadId!);
      if (status === null) return yield* stuck("thread-gone", stopOf(THREAD_GONE, null));
    }
    let attempt = nextGateAttempt(seen);
    // An attempt that was sent (the `gate-sending` step is in the ledger) whose `gate_sent_back`
    // is missing, and a newer run is now visible: the send did reach the session, so the attempt
    // is used. Record that at once, and gate afresh as the next attempt once the run has ended.
    const owed =
      seen.sending !== null && seen.sending.attempt === attempt && seen.commandAttempts.has(attempt)
        ? seen.sending
        : null;
    // A failed re-gate whose new session the ledger records (it is launched before the failure is
    // marked sent, with ordinal 0: the new thread has no run yet): what is left is the
    // transition. One whose launch is not recorded is run again, and launches under the same
    // command id.
    if (ready && owed !== null && seen.launchedSinceSending) {
      yield* append(
        out,
        { event: "gate_sent_back", data: { attempt, run_ordinal: 0 } },
        "gate",
        "gate-send-recovered",
        { attempt },
      );
      return yield* finishRegateFailure(ctx, out, issue, at, pr, attempt);
    }
    if (
      owed !== null &&
      status !== null &&
      status.runOrdinal !== null &&
      status.runOrdinal > owed.runOrdinal
    ) {
      yield* append(
        out,
        { event: "gate_sent_back", data: { attempt, run_ordinal: owed.runOrdinal } },
        "gate",
        "gate-send-recovered",
        { attempt },
      );
      attempt += 1;
    }
    // Building: wait for the session to have finished a run to gate, which has an ordinal.
    let ordinal: number | null = null;
    if (status !== null) {
      if (sessionBusy(seen, status)) return NOT_READY;
      ordinal = status.runOrdinal;
      if (ordinal === null) return NOT_READY;
    }
    const message = status?.lastAssistantMessage ?? null;
    const branch = status?.branch ?? null;
    const stuckUnbound = (unbound: { readonly public: string; readonly detail?: string }) =>
      stuck(
        "pr-not-bound",
        stopOf(
          unbound.public,
          message,
          unbound.detail === undefined ? {} : { detail: unbound.detail },
        ),
      );

    const pull = yield* ctx.tracker.pullRequest(pr);
    // A ready pull request that a person merged or closed is done with, and not stuck.
    if (ready && (pull === null || !pull.open)) {
      yield* endRun(ctx, yield* out.open, at, prUrl, pull, "gate");
      return { kind: "ended" } as const;
    }
    // A pull request's branch does not change, so a re-gate of a ready one binds whichever it is.
    const unbound = checkBinding(
      pull,
      pr,
      ctx.project.base,
      ready && pull !== null ? pull.headRef : branch,
      !ready,
      seen.resumedFrom,
    );
    if (unbound !== null || pull === null) {
      return yield* stuckUnbound(
        unbound ?? { public: `the session reported PR #${pr} but it does not exist` },
      );
    }
    // The session's own pull request that a person merged or closed before the gate could run:
    // nothing is left to gate, and nothing is marked ready.
    if (!pull.open) {
      yield* endRun(ctx, yield* out.open, at, prUrl, pull, "gate");
      return { kind: "ended" } as const;
    }
    // The commit the gate is about is the one the pull request holds now, and it is a commit
    // id: the decision that it passed names it.
    const head = pull.headSha.toLowerCase();
    if (!isCommitId(head)) {
      return yield* new WorkspaceUnexpectedError({
        what: "the pull request's head is not a commit id",
      });
    }
    if (ctx.project.gate.length === 0) return yield* new NoGateCommandsError({ repo: ctx.repo });

    // The commit the head is merged with is the tip the base branch has now.
    let baseSha = (yield* ctx.tracker.branchTip(ctx.project.base)).toLowerCase();
    let regates = gating.regates;

    // Once the commands pass, a base branch that moved while they ran sends the gate round again
    // on the new merge, so the loop ends in a decision or in `stuck`.
    for (;;) {
      const ran = yield* ctx.gate.run({
        dataDir: ctx.dataDir,
        run,
        attempt,
        repo: ctx.repo,
        head,
        base: baseSha,
        provision: ctx.project.provision,
        gate: ctx.project.gate,
        maxConcurrentGates: ctx.maxConcurrentGates,
        ...(ctx.gateOptions !== undefined && { options: ctx.gateOptions }),
      });
      if (ran._tag === "running") return { kind: "running" } as const;
      if (ran._tag === "queued") {
        return { kind: "queued", running: ran.running, max: ran.max } as const;
      }
      // The attempt's lines are in the ledger: where it ran, then every command that ran, or
      // the conflict line that counts it.
      if (ran._tag === "pass") {
        // The commands can run for a long time. The pull request must still be the session's
        // own, whole, and still at the commit that was gated, before anything is marked ready.
        const pullNow = yield* ctx.tracker.pullRequest(pr);
        if (ready && (pullNow === null || !pullNow.open)) {
          yield* endRun(ctx, yield* out.open, at, prUrl, pullNow, "gate");
          return { kind: "ended" } as const;
        }
        // A building run's pull request that someone else took out of draft while the commands
        // ran is not stuck: the factory was about to mark it ready itself.
        const unboundNow = checkBinding(
          pullNow,
          pr,
          ctx.project.base,
          ready && pullNow !== null ? pullNow.headRef : branch,
          false,
          seen.resumedFrom,
        );
        if (unboundNow !== null || pullNow === null) {
          return yield* stuckUnbound(
            unboundNow ?? { public: `the session reported PR #${pr} but it does not exist` },
          );
        }
        // One a person closed without a merge while the commands ran is a decision against the
        // work: the run ends, and the commands' pass is not recorded. One that was merged has
        // its pass recorded first, when it is a pass on the commit that was merged.
        const merged = !pullNow.open && pullNow.merged;
        if (!pullNow.open && !merged) {
          yield* endRun(ctx, yield* out.open, at, prUrl, pullNow, "gate");
          return { kind: "ended" } as const;
        }
        if (pullNow.headSha.toLowerCase() !== head) return NOT_READY;
        // The base branch is read again, and the issue text looked at again, before the pass is
        // recorded. Neither matters to a merged pull request: nothing moves under it.
        if (!merged) {
          const tip = (yield* ctx.tracker.branchTip(ctx.project.base)).toLowerCase();
          if (tip !== baseSha) {
            if (regates >= ctx.project.limits.regates) {
              return yield* stuck("base-kept-moving", { reason: BASE_KEPT_MOVING });
            }
            yield* append(
              out,
              {
                event: "gate_regate",
                data: { sha: head, base_sha: tip, previous_base_sha: baseSha },
              },
              "gate",
              "gate-regated",
              { attempt },
            );
            regates += 1;
            baseSha = tip;
            continue;
          }
          const why = yield* textStop(ctx, issue, seen);
          if (why !== null) return yield* stuck(why.code, { reason: why.reason });
        }
        // Said once for the run, with who did it when GitHub knows. A failed read only costs
        // the name.
        if (!ready && pullNow.open && !pullNow.isDraft && !seen.readyOutside) {
          const by = yield* ctx.tracker.readyBy(pr).pipe(Effect.orElseSucceed(() => null));
          yield* append(
            out,
            { event: "pr_ready_outside", data: { pr, ...(by !== null && { by }) } },
            "gate",
            "pr-ready-outside",
            { attempt },
          );
        }
        // Record the decision before anything is marked ready: a call that dies after
        // `gh pr ready` must not look at a draft that is gone.
        yield* append(
          out,
          { event: "step_changed", data: { step: `${GATE_PASSED} ${head} ${ran.gateCount}` } },
          "gate",
          "gate-passed",
          { attempt },
        );
        const pass: PassRecord = {
          attempt,
          sha: head,
          baseSha,
          atMs: ctx.clock(),
          lines: ran.commands.map((result) => ({
            attempt,
            command: result.command,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          })),
          count: ran.gateCount,
        };
        // An earlier pass's results can be on the pull request; these are new.
        at.gateResultsPosted = false;
        if (merged) {
          yield* finishPass(ctx, out, issue, at, pass, pr, false);
          yield* endRun(ctx, yield* out.open, at, prUrl, pullNow, "gate");
          return { kind: "ended" } as const;
        }
        if (ready) return yield* finishRegatePass(ctx, out, issue, at, pass, pr, owed !== null);
        return yield* finishPass(ctx, out, issue, at, pass, pr, true);
      }

      const conflict = ran._tag === "conflict";
      const text = conflict
        ? mergeConflictMessage(ctx.project.base, ran.paths)
        : failureMessage(ran.failure);
      // A pull request someone else took out of draft goes back to draft before the failure is
      // handled, as `advance` does: only the gate marks it ready. A call that fails leaves it
      // as it is, and stuck. (A ready one goes back to draft with the failure, or with the stop.)
      const pullNow = ready ? null : yield* ctx.tracker.pullRequest(pr);
      if (pullNow !== null && pullNow.open && !pullNow.isDraft) {
        const drafted = yield* Effect.result(ctx.tracker.markPrDraft(pr));
        if (drafted._tag === "Failure") {
          // A rate limit says nothing about the pull request: ask again next pass.
          if (drafted.failure._tag === "GitHubRateLimited") return yield* drafted.failure;
          return yield* stuck(
            "pr-not-bound",
            stopOf(`the session reported PR #${pr} but it is not a draft`, message),
          );
        }
        yield* append(out, { event: "pr_set_draft", data: { pr } }, "gate", "pr-set-draft");
      }
      // Every attempt since the last pass failed. `gate_retries` of them may go back into the
      // session; the one after that is the end.
      const since = attemptsSincePass(seen, attempt);
      if (since > ctx.project.limits.gateRetries) {
        const failedAfter = `the gate failed after ${attempts(since)}`;
        // The conflicted paths and the command output are text from the session's repo, and
        // output can hold what a command printed from its environment: the public comment gets
        // the factory's fixed line, and the ledger and the caller the whole message. Command
        // output ends with the error, so a long one is cut from the front.
        const stop: Stop = {
          reason: conflict
            ? `${failedAfter}: the branch conflicts with the base branch ${sanitize(ctx.project.base, false)}`
            : `${failedAfter}: ${commandCode(ran.failure.command)} failed (${howItEnded(ran.failure)})`,
          detail: `${failedAfter}\n\n${prepareOutputTail(text)}`,
        };
        return yield* stuck("gate-retries-used-up", stop);
      }
      // The failure is about to put a session back to work, so the text it works on is checked as
      // `watch` checks it: someone who is not an instructor may have changed it. A change
      // archives the session first and goes `stuck`, and the pull request goes back to draft on
      // the way, so nothing is sent.
      if (ready) {
        const why = yield* textStop(ctx, issue, seen);
        if (why !== null) return yield* stuck(why.code, { reason: why.reason });
        // A re-gate of a ready pull request has no session to send the failure to: its worktree
        // was removed at the pass. A new session starts from the pull request's branch.
        return yield* relaunchForRegate(
          ctx,
          out,
          issue,
          at,
          run,
          { pr, prUrl, branch: pull.headRef },
          { attempt, message: text },
        );
      }
      // The session the failure goes to, which the gate has read: the run it was gated on.
      if (ordinal === null) return NOT_READY;
      // The step comes first: with it a later call knows which run this attempt was gated on.
      if (
        seen.sending === null ||
        seen.sending.attempt !== attempt ||
        seen.sending.runOrdinal !== ordinal
      ) {
        yield* append(
          out,
          { event: "step_changed", data: { step: `${GATE_SENDING} ${attempt} ${ordinal}` } },
          "gate",
          "gate-sending",
          { attempt },
        );
      }
      const failed = yield* Effect.fromResult(
        transition("building", { kind: "gate-failed", output: `${END_WITH_DONE}\n\n${text}` }),
      );
      // The id holds the ordinal: a retry before the session ran again is the same command, and
      // a send after a newer run is a new one even if T3 dedupes by id.
      const commandId = `softfac:${runIdToString(run)}:gate:${attempt}:${ordinal}`;
      yield* applyActions(
        ctx,
        issue,
        yield* out.open,
        at,
        failed.actions,
        makeCause("gate", "gate-failed"),
        { send: { commandId, attempt, runOrdinal: ordinal } },
      );
      return { kind: "sent-back", attempt } as const;
    }
  });

/**
 * The rest of a passing gate on a pull request that was ready already: a new comment with the
 * results and the head and base they ran against. The state does not change. When a failure of
 * this very attempt was begun and cut short (`reassert`: its `gate-sending` step is in the
 * ledger), part of it may be on GitHub, so the ready state is set again, each call safe to
 * repeat: the pull request ready, the issue assigned and labelled `pr-open`, the status comment.
 */
const finishRegatePass = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  pass: PassRecord,
  pr: number,
  reassert: boolean,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const comment = regateResultsComment(resultsOf(pass), pass.attempt, pass.sha, pass.baseSha);
    const actions: ReadonlyArray<Action> = reassert
      ? [
          { kind: "mark-pr-ready", pr },
          { kind: "assign-to-machine" },
          { kind: "set-label", state: "pr-open" },
          { kind: "update-status-comment" },
          // Last: the step it writes says the pass is complete, so a call cut short before it
          // finds the pass recorded and does the re-assertions again.
          { kind: "post-gate-results", pr },
        ]
      : [{ kind: "post-gate-results", pr }];
    yield* applyActions(
      ctx,
      issue,
      yield* out.open,
      at,
      actions,
      makeCause("gate", "gate-passed"),
      {
        comment,
      },
    );
    return { kind: "passed", pr } as const;
  });

/**
 * A failed re-gate whose failure the new session already has (the ledger says it was sent back,
 * with ordinal 0): what is left of the transition, without sending again. The pull request goes
 * back to draft, the issue is assigned and labelled `building` again, and the state change, which
 * comes last, commits it.
 */
const finishRegateFailure = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  pr: number,
  attempt: number,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const failed = yield* Effect.fromResult(
      transition("pr-open", { kind: "regate-failed", pr, output: "" }),
    );
    const actions = failed.actions.filter((action) => action.kind !== "send-gate-failure");
    yield* applyActions(ctx, issue, yield* out.open, at, actions, makeCause("gate", "gate-failed"));
    return { kind: "sent-back", attempt } as const;
  });

/**
 * A failed re-gate of a ready pull request, with no session to send it to: the session was
 * stopped and its worktree removed when the gate passed. A new session is launched from the pull
 * request's branch at its tip on `origin` (see `relaunchSession`), and its first message carries
 * the failure. It pushes to the same branch, so the same pull request is updated. `pull` is the
 * pull request; `failure` is the failure, which uses one attempt.
 *
 * What is written, in order: the session is stopped if it still has a worktree (a run that was
 * `pr-open` before the worktree went at the pass), the `regate_relaunching` line (the decision,
 * with the branch and the failure text, before any launch call), the launch under the command id
 * `softfac:<run>:regate:<attempt>`, the `session_launched` line with `resumed_from`, the
 * `gate_sent_back` line (ordinal 0: the new thread has no run yet), and then the pull request
 * back to draft, the issue assigned and labelled `building` and the state change that commits it,
 * as `finishRegateFailure` does.
 *
 * From the decision line on the failure is decided, and no call runs the gate again for it:
 * `regate` goes to `resumeRelaunch` first. A branch that cannot be passed to `git push` safely
 * sends the issue `stuck` before anything is decided.
 */
const relaunchForRegate = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  run: RunId,
  pull: { readonly pr: number; readonly prUrl: string; readonly branch: string },
  failure: { readonly attempt: number; readonly message: string },
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const refused = branchRefused(pull.branch);
    if (refused !== null) return yield* stuckWith(ctx, out, issue, at, "launch-failed", refused);
    // Reads first: a failing read is an error with nothing written.
    const detail = yield* ctx.tracker.issue(issue);
    const opened = yield* out.open;
    yield* stopSession(ctx, opened, at);
    const relaunch: Relaunch = {
      fixes: { kind: "regate", attempt: failure.attempt },
      branch: pull.branch,
      message: failure.message,
    };
    yield* ledger(() =>
      opened.append(
        {
          event: "regate_relaunching",
          data: { attempt: failure.attempt, branch: relaunch.branch, message: relaunch.message },
        },
        makeCause("gate", "gate-sending", { attempt: failure.attempt }),
      ),
    );
    return yield* launchForRegate(
      ctx,
      out,
      issue,
      at,
      run,
      { pr: pull.pr, prUrl: pull.prUrl, earlierCall: false },
      detail,
      relaunch,
    );
  });

/**
 * Finishes a relaunch that an earlier call decided (the ledger has its `regate_relaunching` line
 * and no `session_launched` after it) before anything else is looked at: the launch is sent again
 * under the same command id, so T3 answers with the thread it made, or makes it now, and the
 * transition is completed as `relaunchForRegate` completes it. The gate is not run again and the
 * pull request and the base branch are not read: the failure is decided, and a person's merge or
 * close, a closed issue or a changed text is judged by the next pass on a run that now tracks the
 * new thread, which archives it. A failing T3 call is an error with nothing written.
 */
const resumeRelaunch = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  run: RunId,
  pull: { readonly pr: number; readonly prUrl: string },
  relaunch: Relaunch,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const detail = yield* ctx.tracker.issue(issue);
    return yield* launchForRegate(
      ctx,
      out,
      issue,
      at,
      run,
      { ...pull, earlierCall: true },
      detail,
      relaunch,
    );
  });

/**
 * The launch of a decided relaunch and what follows it: `relaunchSession`, then the
 * `gate_sent_back` line (ordinal 0) and the rest of the transition. `earlierCall` says an earlier
 * call reached this point.
 */
const launchForRegate = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  run: RunId,
  from: { readonly pr: number; readonly prUrl: string; readonly earlierCall: boolean },
  detail: IssueDetail,
  relaunch: Relaunch,
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    // Only a re-gate relaunch comes here; a feedback one is the feedback step's.
    const attempt = regateAttempt(relaunch);
    if (attempt === null) return NOT_READY;
    const opened = yield* out.open;
    const launched = yield* relaunchSession(ctx, opened, at, run, from, detail, relaunch);
    if (launched.kind === "stuck") return { kind: "stuck", reason: launched.reason } as const;
    yield* append(
      out,
      { event: "gate_sent_back", data: { attempt, run_ordinal: 0 } },
      "gate",
      "gate-failed",
      { attempt },
    );
    return yield* finishRegateFailure(ctx, out, issue, at, from.pr, attempt);
  });

/** What `regate` did, and what moved since the last recorded pass, for the run's line. */
export interface Regated {
  readonly step: GateStep;
  readonly moved: Moved | null;
}

/**
 * Removes the checkouts of this run that are still on disk: an earlier call died between making
 * one and removing it. One gate runs at a time for a run, so every one is a leftover. A checkout
 * that cannot be removed is noted in the ledger, once for each directory (unless the run is
 * finished, which takes no more lines), and is tried again by the next call.
 */
const removeLeftovers = (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
): Effect.Effect<void, LedgerError> =>
  Effect.gen(function* () {
    const root = yield* ledger(() => gateRoot(ctx.dataDir, run));
    yield* removeLeftoverCheckouts(root, (dir, error) =>
      seen.finished || seen.cleanupFailed.has(dir)
        ? Effect.void
        : append(
            out,
            { event: "gate_cleanup_failed", data: { dir, error } },
            "gate",
            "gate-cleanup-failed",
          ),
    );
    yield* removeEmptyGateRoot(root);
  });

/**
 * Whether a pull request's `head` and its base branch's `tip` are the ones a recorded pass ran
 * against: `regate` answers `unchanged` when they are, and the pass starts no gate. A pass with
 * no head or no base recorded never is.
 */
export const unchangedSince = (
  passedHead: string,
  passedAgainst: string,
  head: string,
  tip: string,
): boolean =>
  passedHead !== "" &&
  passedAgainst !== "" &&
  movedSince(passedHead, passedAgainst, head, tip) === null;

/**
 * The pull request of a `pr-open` run and what its last recorded pass ran against, for the pass
 * to compare with GitHub before it starts the gate (see `lastPass`).
 */
export interface LastPass {
  readonly pr: number;
  /** The head the pass ran on. */
  readonly head: string;
  /** The base branch tip it ran against; empty when the ledger has none. */
  readonly base: string;
}

/**
 * What `regate` compares the pull request and the base tip with, when that comparison is the
 * first thing it would do for the run: the run is `pr-open` and not finished or stuck, has a
 * session and a pull request, has no relaunch pending and no re-gate under way, its worktree line
 * is written and no checkout of an earlier gate is left on disk. `null` for any other run, which
 * is left to the gate. Reads the ledger and the run's gate directory only.
 */
export const lastPass = (
  dataDir: string,
  run: RunId,
): Effect.Effect<LastPass | null, LedgerError> =>
  ledger(() => {
    const seen = readProgress(readRun(dataDir, run).entries);
    const ready =
      seen.threadId !== null &&
      !seen.finished &&
      seen.stuck === null &&
      seen.state === "pr-open" &&
      seen.relaunch === null &&
      !seen.regating &&
      seen.worktreeDone;
    if (seen.lastPr === null || seen.pass === null) return null;
    if (!ready || leftoverCheckouts(dataDir, run).length > 0) return null;
    return { pr: seen.lastPr.pr, head: seen.pass.sha, base: seen.pass.baseSha };
  });

/**
 * Gates a pull request that is ready for review again when its head or the base branch has moved,
 * and ends the run when the pull request has been merged or closed. Call it for a run that is
 * `pr-open` and not finished, on every pass.
 *
 * The run stays open while its pull request waits for a person: `finished` is the summary line
 * and is written when the pull request ends (or the run goes `stuck`), not when the issue reaches
 * `pr-open`. A run that reached `pr-open` before the pass removed worktrees has its session
 * archived and its worktree removed first, once (see `stopSession`).
 *
 * Each call reads the pull request and the tip of the base branch: two API reads for a quiet
 * pass, and nothing else. A pull request that is merged or closed (or gone) finishes the run at
 * once: the session's thread is archived, then the summary line, the only other write, and the
 * answer is `ended`; nothing is gated and nothing is posted. When the head and the tip are the
 * ones the last recorded pass ran against the answer is `unchanged`. A head or a tip that differs
 * (a push to the branch, by anyone, or a moved base) writes a `gate_regate` line and runs the
 * gate on the head merged with the tip, as `gate` runs it, as a new attempt: the pass closed its
 * own. A re-gate that fails or conflicts goes to a new session like any failure, and
 * `gate_retries` counts the failures since the last pass, so a run that passed has its whole
 * send-back budget again. A base that moves again while it runs sends it round again, up to
 * `limits.regates` re-gates since the last pass, and then the issue goes `stuck` with a fixed
 * reason.
 *
 * A pass posts a new comment naming the base it ran against, and the pull request stays ready.
 * A failure puts the pull request back to draft, assigns the issue and labels it `building`, and
 * starts a new session from the pull request's branch on `origin` with the failure in its first
 * message (see `relaunchForRegate`): the old session was stopped, and its worktree removed, when
 * the gate passed, so it does not matter whether its thread is still there. A relaunch that an
 * earlier call decided (its `regate_relaunching` line) and did not record is finished first,
 * without the gate and whatever the pull request, the issue or the base look like now (see
 * `resumeRelaunch`). The gate checks the issue text before it records a pass, as `gate` does. A
 * feedback relaunch that is decided and not committed is the feedback step's, never this one's:
 * the answer is `not-ready` with nothing written. Every call it can make can be made again after
 * a crash: the GitHub call comes first and the ledger line after it, the `state_changed` line is
 * last and is the commit marker, the comment is at-least-once, and a re-gate that was cut short
 * is resumed from the ledger without being counted twice. The answer also says what moved since
 * the last pass, for the run's line; a re-gate that an earlier call began says what that call's
 * line recorded.
 */
export const regate = (ctx: GateContext, run: RunId): Effect.Effect<Regated, GateStepError> =>
  withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      if (asciiLower(run.repo) !== asciiLower(ctx.repo)) {
        return yield* new WrongRepoError({ run, repo: ctx.repo });
      }
      const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
      yield* removeLeftovers(ctx, out, run, seen);
      const last = seen.lastPr;
      if (seen.threadId === null || last === null || seen.finished) {
        return { step: NOT_READY, moved: null };
      }
      const issue = Number(run.issue);
      const at = progressFrom("gate", seen, "triage");
      if (seen.stuck !== null) {
        const step = yield* stuckWith(ctx, out, issue, at, "stuck-resumed", {
          reason: seen.stuck,
        });
        return { step, moved: null };
      }
      if (at.state !== "pr-open") return { step: NOT_READY, moved: null };
      // A feedback relaunch that is decided and not committed is the feedback step's to finish,
      // and the run is never gated meanwhile.
      if (seen.relaunch !== null && regateAttempt(seen.relaunch) === null) {
        return { step: NOT_READY, moved: null };
      }
      // A relaunch that an earlier call decided comes first, whatever the pull request, the
      // issue or the base look like now: the thread it made is on no run until it is finished.
      const pending = pendingRelaunch(seen);
      if (pending !== null) {
        const step = yield* resumeRelaunch(
          ctx,
          out,
          issue,
          at,
          run,
          { pr: last.pr, prUrl: last.url },
          pending,
        );
        return { step, moved: seen.regateMoved };
      }
      let regates = seen.regates;
      if (seen.regating) {
        // A re-gate that an earlier call began. Its pass is recorded and the results are not
        // posted yet; or its failure is recorded as sent and the transition is not committed; or
        // it is to be run again, under the same attempt number.
        if (seen.regatePassed && seen.pass !== null) {
          const pull = yield* ctx.tracker.pullRequest(last.pr);
          if (pull === null || !pull.open) {
            yield* endRun(ctx, yield* out.open, at, last.url, pull, "gate");
            return { step: { kind: "ended" }, moved: null };
          }
          const begun = seen.sending !== null && seen.sending.attempt === seen.pass.attempt;
          const step = yield* finishRegatePass(ctx, out, issue, at, seen.pass, last.pr, begun);
          return { step, moved: seen.regateMoved };
        }
        if (seen.regateSentBack && seen.sending !== null) {
          const step = yield* finishRegateFailure(
            ctx,
            out,
            issue,
            at,
            last.pr,
            seen.sending.attempt,
          );
          return { step, moved: seen.regateMoved };
        }
        // A re-gate under way for an issue a person closed is not run again.
        if ((yield* ctx.tracker.issue(issue)).closed) {
          yield* abandon(ctx, yield* out.open, run, seen, "gate");
          return { step: { kind: "abandoned" }, moved: null };
        }
      } else {
        // A run that reached `pr-open` before a pass removed worktrees still has its session and
        // its worktree: they go now, as the pass would have taken them, with nothing else
        // written. Once the worktree line is there this is never done again.
        if (!seen.worktreeDone) yield* stopSession(ctx, yield* out.open, at);
        // The pull request first: a merge or a close is noticed at once, and a push to the
        // branch is a head the last pass did not see. Then the base branch.
        const pull = yield* ctx.tracker.pullRequest(last.pr);
        if (pull === null || !pull.open) {
          yield* endRun(ctx, yield* out.open, at, last.url, pull, "gate");
          return { step: { kind: "ended" }, moved: null };
        }
        const head = pull.headSha.toLowerCase();
        const tip = (yield* ctx.tracker.branchTip(ctx.project.base)).toLowerCase();
        const passedHead = seen.pass?.sha ?? "";
        const passedAgainst = seen.pass?.baseSha ?? "";
        if (unchangedSince(passedHead, passedAgainst, head, tip)) {
          return { step: { kind: "unchanged" }, moved: null };
        }
        if (!isCommitId(head)) {
          return yield* new WorkspaceUnexpectedError({
            what: "the pull request's head is not a commit id",
          });
        }
        // Only a gate that is about to run asks: a person who closed the issue has taken the work
        // over, as for a run in any other state, and the pull request is left as it is (nothing
        // is written on GitHub). A merge by the run's own pull request was found above.
        if ((yield* ctx.tracker.issue(issue)).closed) {
          yield* abandon(ctx, yield* out.open, run, seen, "gate");
          return { step: { kind: "abandoned" }, moved: null };
        }
        yield* append(
          out,
          {
            event: "gate_regate",
            data: { sha: head, base_sha: tip, previous_base_sha: passedAgainst },
          },
          "gate",
          "gate-regated",
        );
        regates += 1;
      }
      const step = yield* gateAttempts(ctx, out, run, seen, at, {
        threadId: seen.threadId,
        pr: last.pr,
        prUrl: last.url,
        ready: true,
        regates,
      });
      // What moved is read from the ledger, not kept from above: a base that moved again while
      // the commands ran had `gateAttempts` write another `gate_regate` line, and a call resumed
      // later reads the newest one, so the live answer is the same as the resumed one.
      const after = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
      return { step, moved: after.regateMoved };
    }),
  );

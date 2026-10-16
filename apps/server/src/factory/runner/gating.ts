/**
 * The gate of a building run, ported from softfac's `runner/gating.rs` `gate`: a fresh checkout
 * of the pull request's head merged with the base tip, the project's commands in it, and the
 * decision that follows. Required checks (#26) and the re-gate of a `pr-open` pull request (#23)
 * belong to later issues. The checkout, the commands and the removal are `FactoryGate`'s
 * (`gate.ts`), which also writes the attempt's `gate_checkout` and `gate_command` lines; this
 * module decides what they mean.
 *
 * Each call reads the ledger first and does only what it does not record, so calling it again
 * resumes whatever an earlier call left half done. A failure of the tracker, of T3 or of the
 * checkout is an error, with nothing final written, and the next call decides again.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { transition } from "../domain/lifecycle.ts";
import {
  WorkspaceUnexpectedError,
  commandCode,
  gateResultsComment,
  type CommandResult,
  type FactoryGate,
  type GateError,
  type GateOptions,
} from "../gate.ts";
import { ledgerCall as ledger } from "../ledger/errors.ts";
import { makeCause } from "../ledger/events.ts";
import { readRun } from "../ledger/read.ts";
import { asciiLower, runIdToString, type RunId } from "../ledger/runId.ts";
import { isCommitId, sanitize } from "../text.ts";
import type { BoundGitHub } from "../tracker/github.ts";
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
  nextGateAttempt,
  readProgress,
  type PassRecord,
  type Seen,
} from "./progress.ts";
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

/** What the gate asks of the factory besides what a building run asks: the base tip, who marked a pull request ready, and the gate itself. */
export interface GateContext extends BuildingContext {
  readonly tracker: BuildingContext["tracker"] & Pick<BoundGitHub, "branchTip" | "readyBy">;
  readonly gate: Pick<FactoryGate["Service"], "run">;
  readonly maxConcurrentGates: number;
  readonly gateOptions?: GateOptions;
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
      });
    }),
  );

/** The gate's runs on one pull request, from the session read to the decision. */
const gateAttempts = (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  gating: { readonly threadId: string; readonly pr: number; readonly prUrl: string },
): Effect.Effect<GateStep, GateStepError> =>
  Effect.gen(function* () {
    const { threadId, pr, prUrl } = gating;
    const issue = Number(run.issue);
    const stuck = (code: string, stop: Stop) => stuckWith(ctx, out, issue, at, code, stop);

    // The thread, which the gate of a building run reads first, to wait for the session.
    const status = yield* threadStatus(ctx, threadId);
    if (status === null) return yield* stuck("thread-gone", stopOf(THREAD_GONE, null));
    let attempt = nextGateAttempt(seen);
    // An attempt that was sent (the `gate-sending` step is in the ledger) whose `gate_sent_back`
    // is missing, and a newer run is now visible: the send did reach the session, so the attempt
    // is used. Record that at once, and gate afresh as the next attempt once the run has ended.
    const owed =
      seen.sending !== null && seen.sending.attempt === attempt && seen.commandAttempts.has(attempt)
        ? seen.sending
        : null;
    if (owed !== null && status.runOrdinal !== null && status.runOrdinal > owed.runOrdinal) {
      yield* append(
        out,
        { event: "gate_sent_back", data: { attempt, run_ordinal: owed.runOrdinal } },
        "gate",
        "gate-send-recovered",
        { attempt },
      );
      attempt += 1;
    }
    // Wait for the session to have finished a run to gate, which has an ordinal.
    if (sessionBusy(seen, status)) return NOT_READY;
    const ordinal = status.runOrdinal;
    if (ordinal === null) return NOT_READY;
    const message = status.lastAssistantMessage;
    const branch = status.branch;
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
    const unbound = checkBinding(pull, pr, ctx.project.base, branch, true);
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
    let regates = seen.regates;

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
        // A building run's pull request that someone else took out of draft while the commands
        // ran is not stuck: the factory was about to mark it ready itself.
        const unboundNow = checkBinding(pullNow, pr, ctx.project.base, branch, false);
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
        if (pullNow.open && !pullNow.isDraft && !seen.readyOutside) {
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
        return yield* finishPass(ctx, out, issue, at, pass, pr, true);
      }

      const conflict = ran._tag === "conflict";
      const text = conflict
        ? mergeConflictMessage(ctx.project.base, ran.paths)
        : failureMessage(ran.failure);
      // A pull request someone else took out of draft goes back to draft before the failure is
      // handled, as `advance` does: only the gate marks it ready. A call that fails leaves it
      // as it is, and stuck.
      const pullNow = yield* ctx.tracker.pullRequest(pr);
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

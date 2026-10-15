// @effect-diagnostics nodeBuiltinImport:off - a gate lock is a file, checked the way gate.ts makes it.
/**
 * The claim: takes a `ready` issue to `factory:triage` with a run file. Ported from softfac's
 * `runner/start.rs` up to the launch, which issue #16 adds.
 *
 * Before anything is claimed, a fresh start asks GitHub who applied the `factory:ready` label and
 * who edited the issue text since, and builds only when an instructor applied the label and
 * every edit after that moment was an instructor's. Otherwise the issue goes back to
 * `factory:proposed` with one fixed comment and the call is `refused`, with no run and no
 * ledger. The comment is posted before the label moves, so a label call that fails leaves the
 * issue `ready` and the next pass posts the comment again: at-least-once, which beats a
 * relabelled issue with no explanation. A refusal is commented once per label.
 *
 * A new attempt first finishes every older unfinished run of the issue in the ledger, so a run
 * a person has moved on from stops being polled.
 *
 * Calling `start` again resumes. An issue in `triage` whose only assignee is the factory's own
 * user is an interrupted start: a run with no record of what approved it cannot be confirmed, so
 * it fails closed and goes `stuck` (no session was launched, as the record is written first).
 */
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectConfig } from "../config.ts";
import { refusalReason, unapprovedComment, type Refusal } from "../domain/approval.ts";
import { InvalidTransition, stateLabel, transition, type State } from "../domain/lifecycle.ts";
import { gateLockFile } from "../gate.ts";
import { isLedgerError, type LedgerError } from "../ledger/errors.ts";
import { makeCause, type Cause, type ClaimRepair, type Outcome } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { MachineLog } from "../ledger/machineLog.ts";
import { readRun } from "../ledger/read.ts";
import { newRunId, nextAttempt, runIdToString, type RunId } from "../ledger/runId.ts";
import { formatTs } from "../ledger/time.ts";
import { isUtcSecond } from "../tracker/approvalHistory.ts";
import type { GitHubError, makeGitHub } from "../tracker/github.ts";
import { CANNOT_CONFIRM, CUT_SHORT_COMMENT, statusBody, stuckComment } from "./messages.ts";
import { readProgress, type Seen } from "./progress.ts";

type Gh = ReturnType<typeof makeGitHub>;
/** A `makeGitHub` method with its `FactoryProcess` already supplied. */
type Bound<F> = F extends (...args: infer P) => Effect.Effect<infer A, infer E, infer _R>
  ? (...args: P) => Effect.Effect<A, E>
  : never;

/**
 * What the claim asks of the tracker: the subset of `makeGitHub` it calls, with the process
 * runner already supplied, so a test can fake it with plain effects.
 */
export interface Tracker {
  readonly issue: Bound<Gh["issue"]>;
  readonly approval: Bound<Gh["approval"]>;
  readonly claim: Bound<Gh["claim"]>;
  readonly setState: Bound<Gh["setState"]>;
  readonly assign: Bound<Gh["assign"]>;
  readonly unassign: Bound<Gh["unassign"]>;
  readonly postComment: Bound<Gh["postComment"]>;
  readonly upsertStatusComment: Bound<Gh["upsertStatusComment"]>;
  readonly newestFactoryComment: Bound<Gh["newestFactoryComment"]>;
}

export interface StartContext {
  /** `owner/name` as the machine config writes it. */
  readonly repo: string;
  /** The login the tracker knows the factory by. */
  readonly trackerUser: string;
  /** The host name, for the `claimed` line and the status comment. */
  readonly machine: string;
  readonly project: ProjectConfig;
  readonly dataDir: string;
  readonly tracker: Tracker;
  /** Unix epoch milliseconds. */
  readonly clock: () => number;
}

/** What `start` did. */
export type StartOutcome =
  /** The issue is claimed and its run file records it. Issue #16 launches the session from here. */
  | { readonly kind: "claimed"; readonly run: RunId }
  /** The issue was not ours to take. Nothing was written anywhere. */
  | { readonly kind: "skipped"; readonly reason: string }
  /** The issue was `ready` but not approved, so it went back to `factory:proposed` with one fixed comment, and no run was made. */
  | { readonly kind: "refused"; readonly reason: string }
  /** The issue went to `stuck`. */
  | { readonly kind: "stuck"; readonly run: RunId; readonly reason: string };

/** An older unfinished run of the issue has its gate running, so nothing was called or written. */
export class GateRunningError extends Schema.TaggedError<GateRunningError>()("GateRunningError", {
  run: Schema.Struct({ repo: Schema.String, issue: Schema.String, attempt: Schema.Number }),
}) {
  override get message(): string {
    return `the gate of run ${runIdToString(this.run)} is running`;
  }
}

export type StartError = GitHubError | LedgerError | InvalidTransition | GateRunningError;

/** A ledger call, which throws its typed errors, as an effect that fails with them. */
const ledger = <A>(call: () => A): Effect.Effect<A, LedgerError> =>
  Effect.try({
    try: call,
    catch: (error) => {
      if (isLedgerError(error)) return error;
      throw error;
    },
  });

const mention = (issue: number) => `#${issue}`;

const skipped = (issue: number, assignees: ReadonlyArray<string>): StartOutcome => ({
  kind: "skipped",
  reason: `issue ${mention(issue)} is already assigned to ${assignees.join(", ")}`,
});

const isOurs = (assignees: ReadonlyArray<string>, user: string) =>
  assignees.length === 1 && assignees[0]!.toLowerCase() === user.toLowerCase();

export const start = (
  ctx: StartContext,
  issue: number,
): Effect.Effect<StartOutcome, StartError, never> =>
  Effect.gen(function* () {
    const detail = yield* ctx.tracker.issue(issue);
    // A closed issue is never claimed, whatever its label says. Issue #20 ports what softfac
    // does with its unfinished runs; until then they are left alone.
    if (detail.closed) {
      return { kind: "skipped", reason: `issue ${mention(issue)} is closed` };
    }
    const ours = isOurs(detail.assignees, ctx.trackerUser);
    if (detail.state === "ready" && detail.assignees.length === 0) {
      return yield* startFresh(ctx, issue);
    }
    if (detail.state === "ready") return skipped(issue, detail.assignees);
    if (detail.state === "triage" && ours) return yield* resumeStart(ctx, issue);
    return { kind: "skipped", reason: `issue ${mention(issue)} is not labelled factory:ready` };
  });

const startFresh = (ctx: StartContext, issue: number): Effect.Effect<StartOutcome, StartError> =>
  Effect.gen(function* () {
    // Before the claim: nothing is written for an issue that is not approved except the
    // explanation.
    const approval = yield* ctx.tracker.approval(issue, ctx.project.instructors);
    if (approval.kind === "refused") return yield* refuseStart(ctx, issue, approval.refusal);
    const { labeledAt, labeledBy } = approval;
    const run = newRunId(
      ctx.repo,
      String(issue),
      nextAttempt(ctx.dataDir, ctx.repo, String(issue)),
    );
    // Before the claim, so a crash after it cannot leave an older run stranded in front of a
    // resume. An instructor applied the label again, which is what began this attempt.
    yield* finishOlderRuns(ctx, issue, run.attempt, labeledBy === "" ? null : labeledBy);
    const claimed = yield* ctx.tracker.claim(issue, ctx.trackerUser, "ready", "triage").pipe(
      // The edit may have landed all the same. See `repairClaim`.
      Effect.catch((error) => repairClaim(ctx, issue, error)),
    );
    if (claimed.kind === "skipped-assigned") return skipped(issue, claimed.assignees);
    const out = yield* ledger(() => Ledger.create(ctx.dataDir, run, { clock: ctx.clock }));
    try {
      // First line of the run: what it was approved on, for the checks that come later.
      yield* ledger(() =>
        out.append(
          { event: "step_changed", data: { step: `approved ${labeledAt}` } },
          makeCause("start", "approved", labeledBy === "" ? {} : { actor: labeledBy }),
        ),
      );
      return yield* begin(ctx, issue, run, out);
    } finally {
      out.close();
    }
  });

/**
 * What to do about a claim call that returned `error`: GitHub can apply the edit and still
 * answer with an error, which leaves the issue in `factory:triage` with no assignee, where no
 * pass looks for it. The issue is read again. If the claim is whole, or only the assignee is
 * missing, it is finished and the run may begin. An issue with no single factory label (the new
 * one added and the old one not yet removed, or neither) counts as claimed: moving it to
 * `factory:triage` leaves it one label. If it cannot be finished, the issue loses our assignee
 * and goes to `factory:proposed`, in that order, so a failure in between leaves a `triage`
 * issue with no assignee, which the pass moves to `proposed`, and never a `proposed` issue with
 * an assignee. When both worked, the cut-short comment is posted (a comment that fails is
 * ignored) and a line in the machine log says `released`. Either way the original `error` is
 * the answer. If nothing changed, or another person has the issue, or it is closed, or it
 * cannot be read, nothing is written and `error` is the answer, as it was before.
 */
const repairClaim = (
  ctx: StartContext,
  issue: number,
  error: GitHubError,
): Effect.Effect<{ readonly kind: "claimed" }, GitHubError> =>
  Effect.gen(function* () {
    const now = yield* ctx.tracker.issue(issue).pipe(Effect.option);
    if (now._tag === "None") return yield* error;
    const seen = now.value;
    const user = ctx.trackerUser;
    const ours = isOurs(seen.assignees, user);
    const nobody = seen.assignees.length === 0;
    const swapped = seen.state === "triage" || seen.state === "ready" || seen.state === null;
    // Still `factory:ready` with no assignee: nothing was applied.
    if (seen.closed || !swapped || !(ours || nobody) || (seen.state === "ready" && nobody)) {
      return yield* error;
    }
    const ok = <A>(call: Effect.Effect<A, GitHubError>) =>
      call.pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    const assigned = nobody ? yield* ok(ctx.tracker.assign(issue, user)) : true;
    const labelled =
      assigned && (seen.state === "triage" || (yield* ok(ctx.tracker.setState(issue, "triage"))));
    if (assigned && labelled) {
      recordClaimRepair(ctx, issue, "finished");
      return { kind: "claimed" };
    }
    // Both are tried, so a label that will not move does not leave our assignee on the issue.
    const off = yield* ok(ctx.tracker.unassign(issue, user));
    const moved = yield* ok(ctx.tracker.setState(issue, "proposed"));
    if (off && moved) {
      yield* ok(ctx.tracker.postComment(issue, CUT_SHORT_COMMENT));
      recordClaimRepair(ctx, issue, "released");
    }
    return yield* error;
  });

/** Writes a `claim_repaired` line to the machine log. A log that cannot be written is not worth failing the claim for. */
const recordClaimRepair = (ctx: StartContext, issue: number, outcome: ClaimRepair): void => {
  try {
    const log = MachineLog.open(ctx.dataDir, { clock: ctx.clock });
    try {
      log.append({
        event: "claim_repaired",
        data: { repo: ctx.repo, issue: String(issue), outcome },
      });
    } finally {
      log.close();
    }
  } catch {
    // Not worth failing the claim for.
  }
};

/** How long a refusal comment that has no label time to be compared with counts as recent. */
const RECENT_MS = 60 * 60 * 1000;

/** The moment `ms`, in GitHub's `YYYY-MM-DDTHH:MM:SSZ` form, so it compares as text with GitHub's times. */
export const utcSecond = (ms: number): string => `${formatTs(ms).slice(0, 19)}Z`;

/**
 * Whether the issue's newest factory comment already says this refusal for the label it was
 * judged on: it says the same text and is newer than the label event (a comment from before the
 * label was about an earlier refusal). A refusal without a label time is matched on text alone,
 * for a comment under an hour old by the context's clock. A comment whose time is not GitHub's
 * form never counts.
 */
const alreadySaid = (
  ctx: StartContext,
  refusal: Refusal,
  text: string,
  newest: { readonly body: string; readonly createdAt: string } | null,
): boolean => {
  if (newest === null || newest.body !== text || !isUtcSecond(newest.createdAt)) return false;
  if ("labeledAt" in refusal) return newest.createdAt > refusal.labeledAt;
  return newest.createdAt > utcSecond(ctx.clock() - RECENT_MS);
};

/**
 * Takes a refused `ready` issue back to `proposed`: the comment first, then the label. There is
 * no run, so nothing is written to a ledger. A label call that fails leaves the issue `ready`
 * and the next pass tries it again. The comment is not posted again while it is still the
 * issue's newest factory comment.
 */
const refuseStart = (
  ctx: StartContext,
  issue: number,
  refusal: Refusal,
): Effect.Effect<StartOutcome, GitHubError | InvalidTransition> =>
  Effect.gen(function* () {
    const reason = refusalReason(refusal);
    const moved = yield* Effect.fromResult(transition("ready", { kind: "unapproved", reason }));
    for (const action of moved.actions) {
      switch (action.kind) {
        case "post-unapproved": {
          const text = unapprovedComment(refusal);
          const newest = yield* ctx.tracker.newestFactoryComment(issue);
          if (!alreadySaid(ctx, refusal, text, newest)) {
            yield* ctx.tracker.postComment(issue, text);
          }
          break;
        }
        case "set-label":
          yield* ctx.tracker.setState(issue, action.state);
          break;
        default:
          return yield* new InvalidTransition({ state: "ready", event: "unapproved" });
      }
    }
    return { kind: "refused", reason: `issue ${mention(issue)} was not approved: ${reason}` };
  });

const resumeStart = (ctx: StartContext, issue: number): Effect.Effect<StartOutcome, StartError> =>
  Effect.gen(function* () {
    const next = nextAttempt(ctx.dataDir, ctx.repo, String(issue));
    if (next > 1) {
      const newest = newRunId(ctx.repo, String(issue), next - 1);
      const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, newest))).entries);
      // A run already in `stuck` is over; it is finished below with the others. Any other
      // unfinished run is left to the step that owns its state: launching a claimed run is
      // issue #16's.
      if (!seen.finished && seen.state !== "stuck") {
        return {
          kind: "skipped",
          reason: `issue ${mention(issue)} has an unfinished run in state ${seen.state ?? "none"}`,
        };
      }
    }
    const run = newRunId(ctx.repo, String(issue), next);
    yield* finishOlderRuns(ctx, issue, next, null);
    const out = yield* ledger(() => Ledger.create(ctx.dataDir, run, { clock: ctx.clock }));
    try {
      return yield* begin(ctx, issue, run, out);
    } finally {
      out.close();
    }
  });

/**
 * Records the claim the tracker call has made (assign, and label `triage`), then goes on from
 * what the ledger shows. A run with no record of what approved it cannot be confirmed, so it
 * fails closed. The record is written before any launch, so with no session in the ledger
 * either, no launch was ever sent, and there is nothing to archive.
 */
const begin = (
  ctx: StartContext,
  issue: number,
  run: RunId,
  out: Ledger,
): Effect.Effect<StartOutcome, StartError> =>
  Effect.gen(function* () {
    const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
    const claimed = yield* Effect.fromResult(transition("ready", { kind: "claimed" }));
    const claim = makeCause("start", "claimed");
    if (!seen.claimed) {
      yield* ledger(() =>
        out.append(
          { event: "claimed", data: { machine: ctx.machine, github_user: ctx.trackerUser } },
          claim,
        ),
      );
    }
    if (seen.state === null) {
      yield* ledger(() =>
        out.append({ event: "state_changed", data: { from: "ready", to: claimed.next } }, claim),
      );
    }
    const at: Progress = { state: seen.state ?? claimed.next, threadId: seen.threadId, seen };
    if (seen.approvedAt === null && seen.threadId === null) {
      yield* goStuck(ctx, issue, out, at, "approval-unconfirmed", CANNOT_CONFIRM);
      return { kind: "stuck", run, reason: CANNOT_CONFIRM };
    }
    return { kind: "claimed", run };
  });

/** Where the issue stands while the stuck actions are applied. */
interface Progress {
  readonly state: State;
  readonly threadId: string | null;
  readonly seen: Seen;
}

/**
 * The stuck path: the actions `lifecycle.transition` asks for on a failure, in order, then the
 * `state_changed` line and the summary line. A comment is skipped when the ledger already
 * records it; the label, the release and the status comment are repeated safely. `code` is the
 * reason of every line it writes.
 */
const goStuck = (
  ctx: StartContext,
  issue: number,
  out: Ledger,
  at: Progress,
  code: string,
  reason: string,
): Effect.Effect<void, StartError> =>
  Effect.gen(function* () {
    const cause = makeCause("start", code);
    if (at.state === "stuck") {
      yield* ledger(() => out.finish("stuck", null, null, cause));
      return;
    }
    const failed = yield* Effect.fromResult(transition(at.state, { kind: "failed", reason }));
    let movedTo: State | null = null;
    let stuckPosted = at.seen.stuck !== null;
    for (const action of failed.actions) {
      switch (action.kind) {
        case "post-stuck-comment":
          if (!stuckPosted) {
            yield* ctx.tracker.postComment(issue, stuckComment(reason));
            yield* ledger(() => out.append({ event: "stuck", data: { reason } }, cause));
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

/**
 * Finishes every unfinished run of the issue before attempt `below`, by its last state, so it is
 * not polled again and cannot write to an issue a newer attempt now owns. While the gate of any
 * of them is running, none of them is finished. Until issue #20 ports the stop, a run that names
 * a session or a pull request is finished in the ledger only: nothing is archived or drafted.
 */
const finishOlderRuns = (
  ctx: StartContext,
  issue: number,
  below: number,
  appliedBy: string | null,
): Effect.Effect<void, LedgerError | GateRunningError> =>
  Effect.gen(function* () {
    const older: Array<{ id: RunId; seen: Seen }> = [];
    for (let attempt = 1; attempt < below; attempt += 1) {
      const id = newRunId(ctx.repo, String(issue), attempt);
      const record = yield* ledger(() => readRun(ctx.dataDir, id)).pipe(
        Effect.catchTag("LedgerNotFoundError", () => Effect.succeed(null)),
      );
      if (record === null) continue;
      const seen = readProgress(record.entries);
      if (seen.finished) continue;
      if (NodeFS.existsSync(gateLockFile(ctx.dataDir, id))) {
        return yield* new GateRunningError({ run: id });
      }
      older.push({ id, seen });
    }
    for (const { id, seen } of older) {
      const outcome: Outcome =
        seen.state === "needs-info" ? "needs-info" : seen.state === "pr-open" ? "pr-open" : "stuck";
      // A person relabelled the issue, so a new attempt began: `appliedBy` is the instructor
      // whose `factory:ready` label began it, when this start is the one that was approved.
      const cause: Cause = makeCause(
        "start",
        "new-attempt-started",
        appliedBy === null ? {} : { actor: appliedBy, label: stateLabel("ready") },
      );
      const out = yield* ledger(() => Ledger.open(ctx.dataDir, id, { clock: ctx.clock }));
      try {
        yield* ledger(() => out.finish(outcome, null, null, cause));
      } finally {
        out.close();
      }
    }
  });

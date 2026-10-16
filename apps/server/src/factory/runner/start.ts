// @effect-diagnostics nodeBuiltinImport:off - a gate lock is a file, checked the way gate.ts makes it.
/**
 * The claim: takes a `ready` issue to `factory:triage` with a run file. Ported from softfac's
 * `runner/start.rs`, through the launch of the `/factory` session and the move to
 * `factory:building`.
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
 * a person has moved on from stops being polled. A closed issue is never claimed: its unfinished
 * runs are abandoned instead, each with its session archived (see `abandonClosed`).
 *
 * The session is launched under a command id derived from the run, after the ledger says a
 * launch is about to be sent, so a launch that fails on our side is found again by sending the
 * same id. The issue text is checked again once the session exists: a change stops the run and
 * archives the session.
 *
 * Calling `start` again resumes; `resume` does only that. An issue in `triage` whose only
 * assignee is the factory's own user is an interrupted start, and every step goes on from what
 * the ledger records. A run with no record of what approved it cannot be confirmed, so it fails
 * closed and goes `stuck` (no session was launched, as the record is written first).
 */
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectConfig } from "../config.ts";
import { refusalReason, unapprovedComment, type Refusal } from "../domain/approval.ts";
import { InvalidTransition, stateLabel, transition } from "../domain/lifecycle.ts";
import { gateLockFile } from "../gate.ts";
import { ledgerCall as ledger, type LedgerError } from "../ledger/errors.ts";
import { makeCause, type Cause, type ClaimRepair, type Outcome } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { MachineLog } from "../ledger/machineLog.ts";
import { readRun, type Entry } from "../ledger/read.ts";
import { newRunId, nextAttempt, runIdToString, type RunId } from "../ledger/runId.ts";
import { formatTs } from "../ledger/time.ts";
import { isUtcSecond } from "../tracker/approvalHistory.ts";
import {
  isNotFound,
  type BoundGitHub,
  type GitHubError,
  type IssueDetail,
} from "../tracker/github.ts";
import type {
  FactorySessions,
  MessageRejectedError,
  Model,
  SessionsError,
  ThreadNotFoundError,
} from "../t3/sessions.ts";
import {
  CANNOT_CONFIRM,
  CUT_SHORT_COMMENT,
  LAUNCH_FAILED,
  TEXT_CHANGED,
  launchMessage,
  sessionMayExistNote,
  type ResumeAfter,
  type ResumeFrom,
} from "./messages.ts";
import {
  APPROVAL_RECHECKED,
  LAUNCH_SENDING,
  LAUNCH_SENDING_RESUMED,
  field,
  readProgress,
  type Seen,
} from "./progress.ts";
import {
  abandon,
  describe,
  finishBuilding,
  goStuck,
  movedOnByClosing,
  progressFrom,
} from "./run.ts";

/**
 * What the claim asks of the tracker: the subset of `makeGitHub` it calls, with the process
 * runner already supplied (`bindProcess`), so a test can fake it with plain effects. A later
 * step adds the names it calls here and a line to the fake.
 */
export type Tracker = Pick<
  BoundGitHub,
  | "issue"
  | "approval"
  | "claim"
  | "setState"
  | "assign"
  | "unassign"
  | "postComment"
  | "upsertStatusComment"
  | "newestFactoryComment"
  | "textCheck"
  | "markPrReady"
  | "markPrDraft"
  | "commentOnPr"
  | "pullRequest"
  | "closedBy"
  | "branchTip"
  | "textEditedSince"
>;

/** The subset of `FactorySessions` the claim calls. */
export type Sessions = Pick<
  FactorySessions["Service"],
  "findProject" | "launch" | "thread" | "archive" | "removeWorktree" | "send"
>;

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
  /** The local clone the T3 project is rooted at: `WatchedRepo.path`. */
  readonly repoPath: string;
  /** The `GH_CONFIG_DIR` the launch message names. */
  readonly ghConfigDir: string;
  readonly model: Model;
  readonly sessions: Sessions;
  /** Unix epoch milliseconds. */
  readonly clock: () => number;
}

/** What `start` did. */
export type StartOutcome =
  /** The issue is claimed, its session is launched and the issue is `factory:building`. */
  | { readonly kind: "started"; readonly run: RunId; readonly threadId: string }
  /**
   * The issue was not ours to take. Nothing was written anywhere. `moved` says a person closed
   * the issue, or put it back to `factory:ready` with nobody assigned, which the claim step takes.
   */
  | { readonly kind: "skipped"; readonly reason: string; readonly moved?: "closed" | "ready" }
  /** The issue was `ready` but not approved, so it went back to `factory:proposed` with one fixed comment, and no run was made. */
  | { readonly kind: "refused"; readonly reason: string }
  /** The issue went to `stuck`. */
  | { readonly kind: "stuck"; readonly run: RunId; readonly reason: string }
  /**
   * The issue is closed and a person closed it: its unfinished runs are finished and their
   * sessions archived. `mayHaveSession` names the runs that sent a launch the ledger never got a
   * thread for: a session may exist that this could not archive. `error` is why a later run could
   * not be ended after earlier ones were, which the next call tries again; the runs it names are
   * finished, so this is the only time they are named.
   */
  | {
      readonly kind: "abandoned";
      readonly mayHaveSession: ReadonlyArray<RunId>;
      readonly error?: StartError;
    };

/** An older unfinished run of the issue has its gate running, so nothing was called or written. */
export class GateRunningError extends Schema.TaggedError<GateRunningError>()("GateRunningError", {
  run: Schema.Struct({ repo: Schema.String, issue: Schema.String, attempt: Schema.Number }),
}) {
  override get message(): string {
    return `the gate of run ${runIdToString(this.run)} is running`;
  }
}

export type StartError =
  | GitHubError
  | LedgerError
  | InvalidTransition
  | GateRunningError
  | SessionsError
  | ThreadNotFoundError
  | MessageRejectedError;

/** An issue as the pass's lines and the skip reasons name it. */
export const mention = (issue: number) => `#${issue}`;

const skipped = (issue: number, assignees: ReadonlyArray<string>): StartOutcome => ({
  kind: "skipped",
  reason: `issue ${mention(issue)} is already assigned to ${assignees.join(", ")}`,
});

/** Whether `user` is the only assignee. Not `asciiLower`: a Linear user can be a display name. */
export const isOurs = (assignees: ReadonlyArray<string>, user: string) =>
  assignees.length === 1 && assignees[0]!.toLowerCase() === user.toLowerCase();

export const start = (
  ctx: StartContext,
  issue: number,
): Effect.Effect<StartOutcome, StartError, never> =>
  Effect.gen(function* () {
    const detail = yield* ctx.tracker.issue(issue);
    // A closed issue is never claimed, whatever its label says: its unfinished runs are ended.
    if (detail.closed) return yield* abandonClosed(ctx, issue);
    if (detail.state === "ready" && detail.assignees.length === 0) {
      return yield* startFresh(ctx, issue, detail);
    }
    if (detail.state === "ready") return skipped(issue, detail.assignees);
    return yield* goOn(ctx, issue, detail);
  });

/**
 * `start` for a claim already made, which never makes one: what the pass calls for a run it
 * knows of and for a `triage` issue of ours with no run. An issue someone put back to
 * `factory:ready` is left to the claim step, which checks the pause, the limit and the blockers
 * first, and which finishes the issue's older runs when it claims it.
 */
export const resume = (
  ctx: StartContext,
  issue: number,
): Effect.Effect<StartOutcome, StartError, never> =>
  Effect.gen(function* () {
    const detail = yield* ctx.tracker.issue(issue);
    if (detail.closed) return yield* abandonClosed(ctx, issue);
    if (detail.state === "ready" && detail.assignees.length === 0) {
      return { kind: "skipped", reason: `issue ${mention(issue)} is ready again`, moved: "ready" };
    }
    if (detail.state === "ready") return skipped(issue, detail.assignees);
    return yield* goOn(ctx, issue, detail);
  });

const closed = (issue: number): StartOutcome => ({
  kind: "skipped",
  reason: `issue ${mention(issue)} is closed`,
  moved: "closed",
});

/**
 * What `start` does with a closed issue: every unfinished run of it that a person's closing ended
 * is abandoned (see `abandon`), oldest first, so a run stops being polled and its session stops.
 * Nothing is claimed or written on GitHub. A run in `pr-open` or `stuck` has nothing left to
 * write and is left alone, as is a run whose own merged pull request closed the issue: `advance`
 * or `gate` ends that one. While the gate of any of those runs is running, none of them is
 * touched (`GateRunningError`). With no run to abandon the issue is `skipped` as closed. A run
 * that cannot be ended stops the walk: with no run ended before it that is the error, and after
 * one it is `abandoned` with the error, so the runs already finished are still named.
 */
const abandonClosed = (ctx: StartContext, issue: number): Effect.Effect<StartOutcome, StartError> =>
  Effect.gen(function* () {
    const next = nextAttempt(ctx.dataDir, ctx.repo, String(issue));
    const unfinished = yield* unfinishedRuns(
      ctx,
      issue,
      next,
      (seen) => seen.state !== "pr-open" && seen.state !== "stuck",
    );
    let abandoned = false;
    const mayHaveSession: Array<RunId> = [];
    for (const { id, seen } of unfinished) {
      const ended = yield* Effect.result(
        Effect.gen(function* () {
          const closing = yield* movedOnByClosing(ctx, seen, true);
          if (closing.kind !== "persons-move") return "left" as const;
          const out = yield* ledger(() => Ledger.open(ctx.dataDir, id, { clock: ctx.clock }));
          try {
            return (yield* abandon(ctx, out, id, seen, "start")) ? "may-have-session" : "ended";
          } finally {
            out.close();
          }
        }),
      );
      if (ended._tag === "Failure") {
        if (!abandoned) return yield* Effect.fail(ended.failure);
        return { kind: "abandoned", mayHaveSession, error: ended.failure };
      }
      if (ended.success === "left") continue;
      if (ended.success === "may-have-session") mayHaveSession.push(id);
      abandoned = true;
    }
    return abandoned ? { kind: "abandoned", mayHaveSession } : closed(issue);
  });

/**
 * Goes on from the ledger with an issue that is not `ready`: a `triage` issue of ours, or a
 * `stuck` issue whose newest run gave up and was cut short before its summary line (the label
 * moves before the release and the status comment, so a failure in between leaves the run
 * unfinished in `triage`), which finishes the stuck path.
 */
const goOn = (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
): Effect.Effect<StartOutcome, StartError> =>
  Effect.gen(function* () {
    if (detail.state === "triage" && isOurs(detail.assignees, ctx.trackerUser)) {
      return yield* resumeStart(ctx, issue, detail);
    }
    if (detail.state === "stuck" && (yield* stuckCutShort(ctx, issue))) {
      return yield* resumeStart(ctx, issue, detail);
    }
    return {
      kind: "skipped",
      reason: `issue ${mention(issue)} is not factory:triage assigned to ${ctx.trackerUser} alone`,
    };
  });

/** Whether the issue's newest run is unfinished, still in `triage`, and its ledger says it went stuck. */
const stuckCutShort = (ctx: StartContext, issue: number): Effect.Effect<boolean, LedgerError> =>
  Effect.gen(function* () {
    const next = nextAttempt(ctx.dataDir, ctx.repo, String(issue));
    if (next === 1) return false;
    const newest = newRunId(ctx.repo, String(issue), next - 1);
    const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, newest))).entries);
    return (
      !seen.finished && seen.stuck !== null && (seen.state === null || seen.state === "triage")
    );
  });

const startFresh = (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
): Effect.Effect<StartOutcome, StartError> =>
  Effect.gen(function* () {
    // Before the claim: nothing is written for an issue that is not approved except the
    // explanation.
    const approval = yield* ctx.tracker.approval(issue, ctx.project.instructors);
    if (approval.kind === "refused") return yield* refuseStart(ctx, issue, approval.refusal);
    const { labeledAt, labeledBy } = approval;
    // Also before the claim: with T3 out of reach nothing is claimed, so no issue is left in
    // `triage` for a launch that cannot be sent.
    const project = yield* ctx.sessions.findProject(ctx.repoPath);
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
      return yield* begin(ctx, issue, detail, run, out, project);
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
      yield* recordClaimRepair(ctx, issue, "finished");
      return { kind: "claimed" };
    }
    // Both are tried, so a label that will not move does not leave our assignee on the issue.
    const off = yield* ok(ctx.tracker.unassign(issue, user));
    const moved = yield* ok(ctx.tracker.setState(issue, "proposed"));
    if (off && moved) {
      yield* ok(ctx.tracker.postComment(issue, CUT_SHORT_COMMENT));
      yield* recordClaimRepair(ctx, issue, "released");
    }
    return yield* error;
  });

/**
 * Writes a `claim_repaired` line to the machine log. A log that cannot be written is not worth
 * failing the claim for, so it is logged as a warning that names the issue.
 */
const recordClaimRepair = (
  ctx: StartContext,
  issue: number,
  outcome: ClaimRepair,
): Effect.Effect<void> =>
  ledger(() => {
    const log = MachineLog.open(ctx.dataDir, { clock: ctx.clock });
    try {
      log.append({
        event: "claim_repaired",
        data: { repo: ctx.repo, issue: String(issue), outcome },
      });
    } finally {
      log.close();
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `claim_repaired (${outcome}) for ${ctx.repo}${mention(issue)} could not be written to the machine log`,
        cause,
      ),
    ),
  );

/** How long a refusal comment that has no label time to be compared with counts as recent. */
const RECENT_MS = 60 * 60 * 1000;

/** The moment `ms`, in GitHub's `YYYY-MM-DDTHH:MM:SSZ` form, so it compares as text with GitHub's times. */
export const utcSecond = (ms: number): string => `${formatTs(ms).slice(0, 19)}Z`;

/**
 * Whether the issue's newest factory comment says `text` with a creation time in GitHub's
 * `YYYY-MM-DDTHH:MM:SSZ` form, so the time compares as text with a label time. A comment whose
 * time is not in that form never counts as already said.
 */
export const newestSays = <C extends { readonly body: string; readonly createdAt: string }>(
  newest: C | null,
  text: string,
): newest is C => newest !== null && newest.body === text && isUtcSecond(newest.createdAt);

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
  if (!newestSays(newest, text)) return false;
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

const resumeStart = (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
): Effect.Effect<StartOutcome, StartError> =>
  Effect.gen(function* () {
    const next = nextAttempt(ctx.dataDir, ctx.repo, String(issue));
    if (next > 1) {
      const newest = newRunId(ctx.repo, String(issue), next - 1);
      const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, newest))).entries);
      // A run already in `stuck` is over; it is finished below with the others. A run still in
      // `triage` (or not yet in any state) was cut short, so `begin` goes on from what its
      // ledger records, whatever it was approved on. Any other unfinished run is left to the
      // step that owns its state.
      if (!seen.finished && seen.state !== "stuck") {
        if (seen.state === null || seen.state === "triage") {
          const out = yield* ledger(() => Ledger.open(ctx.dataDir, newest, { clock: ctx.clock }));
          try {
            return yield* begin(ctx, issue, detail, newest, out, undefined);
          } finally {
            out.close();
          }
        }
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
      return yield* begin(ctx, issue, detail, run, out, undefined);
    } finally {
      out.close();
    }
  });

/**
 * Records the claim the tracker call has made (assign, and label `triage`), then goes on from
 * what the ledger shows: launch the session, look at the issue text once more, move the issue
 * to `building`. A run with no record of what approved it cannot be confirmed, so it fails
 * closed. The record is written before any launch, so with no session in the ledger either, no
 * launch was ever sent, and there is nothing to archive. `project` is the T3 project found
 * before the claim; `undefined` on a resume, which looks it up only if it has to launch.
 */
const begin = (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
  run: RunId,
  out: Ledger,
  project: string | null | undefined,
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
    const at = progressFrom("start", seen, claimed.next);
    // A decision to give up that is already in the ledger stands.
    if (seen.stuck !== null) {
      yield* goStuck(ctx, issue, out, at, "stuck-resumed", { reason: seen.stuck });
      return { kind: "stuck", run, reason: seen.stuck };
    }
    // The record is written before any launch: with no session either, nothing was sent, so
    // nothing is launched here (a session on unconfirmed text, only to archive it).
    if (seen.approvedAt === null && seen.threadId === null) {
      yield* goStuck(ctx, issue, out, at, "approval-unconfirmed", { reason: CANNOT_CONFIRM });
      return { kind: "stuck", run, reason: CANNOT_CONFIRM };
    }
    // A launch that is not in the ledger may still have started a thread: the call can fail on
    // our side after T3 acted. Launching again under the same command id either starts the
    // session or returns the thread T3 already started. The text is looked at after the launch
    // and never before it: skipping the launch for a changed text could leave such a thread
    // running with nobody to stop it.
    let threadId = seen.threadId;
    if (threadId === null) {
      const launched = yield* launchSession(ctx, issue, detail, run, out, seen, project);
      if (!launched.ok) {
        yield* goStuck(ctx, issue, out, at, "launch-failed", {
          reason: LAUNCH_FAILED,
          detail: launched.detail,
        });
        return { kind: "stuck", run, reason: launched.detail };
      }
      threadId = launched.threadId;
      // What the ledger now records, for a stop that has to remove the worktree while T3 may not
      // report its path yet.
      at.worktree = launched.worktree;
    }
    at.threadId = threadId;
    if (seen.approvedAt === null) {
      yield* goStuck(ctx, issue, out, at, "approval-unconfirmed", { reason: CANNOT_CONFIRM });
      return { kind: "stuck", run, reason: CANNOT_CONFIRM };
    }
    // The session reads the issue live a few seconds after the approval, and the claim has told
    // anyone watching the labels that it is starting. Check the text again now that the session
    // exists: a change by someone who is not an instructor stops the run. A failed read is an
    // error, and the next call checks again; the step says the check passed.
    if (!seen.rechecked) {
      const check = yield* ctx.tracker.textCheck(issue, seen.approvedAt, ctx.project.instructors);
      // A history that cannot be judged counts as changed.
      if (check !== "unchanged") {
        yield* goStuck(ctx, issue, out, at, "text-changed-before-start", { reason: TEXT_CHANGED });
        return { kind: "stuck", run, reason: TEXT_CHANGED };
      }
      yield* ledger(() =>
        out.append(
          { event: "step_changed", data: { step: APPROVAL_RECHECKED } },
          makeCause("start", "approval-rechecked"),
        ),
      );
    }
    if (at.state !== "building") yield* finishBuilding(ctx, issue, out, at);
    return { kind: "started", run, threadId };
  });

type Launch =
  | { readonly ok: true; readonly threadId: string; readonly worktree: string | null }
  | { readonly ok: false; readonly detail: string };

/**
 * Sends the launch: `launch-sending` is written once per run, before the first call, so a
 * launch that fails on our side is known to have been sent. The command id comes from the run,
 * so sending it again returns the thread T3 already made. In-process, every failure of the call
 * is T3's answer after the request went out: it is final, and a session may exist. A launch that
 * was never sent (no project) says so only when an earlier pass did send one.
 *
 * What the launch starts from is decided once, before the first call (`resumeFrom`, which asks
 * GitHub), and the step records it: `launch-sending` for a start from `base`,
 * `launch-sending resumed-from <branch>` for a resume. A call sent again reuses the recorded
 * decision and asks GitHub nothing, so every request under the one command id is the same
 * request, the one T3 acted on, and the ledger's `resumed_from` says what the thread T3 answers
 * with was really made from.
 */
const launchSession = (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
  run: RunId,
  out: Ledger,
  seen: Seen,
  project: string | null | undefined,
): Effect.Effect<Launch, StartError> =>
  Effect.gen(function* () {
    const commandId = `softfac:${runIdToString(run)}:launch`;
    const projectId =
      project === undefined ? yield* ctx.sessions.findProject(ctx.repoPath) : project;
    if (projectId === null) {
      const missing = "no T3 project for this repo on this machine";
      return {
        ok: false,
        detail: seen.launchSent ? sessionMayExistNote(missing, commandId) : missing,
      };
    }
    const resumed = seen.launchSent
      ? seen.launchResumedFrom === null
        ? null
        : yield* recordedResume(ctx, run, seen.launchResumedFrom)
      : yield* resumeFrom(ctx, run, issue);
    if (!seen.launchSent) {
      yield* ledger(() =>
        out.append(
          {
            event: "step_changed",
            data: {
              step:
                resumed === null ? LAUNCH_SENDING : `${LAUNCH_SENDING_RESUMED}${resumed.branch}`,
            },
          },
          makeCause("start", "launch-sending"),
        ),
      );
    }
    const launched = yield* Effect.result(
      ctx.sessions.launch({
        commandId,
        projectId,
        title: `${ctx.repo}#${issue} ${detail.title}`,
        baseRef: resumed === null ? ctx.project.base : resumed.branch,
        startFromOrigin: resumed !== null,
        message: launchMessage(
          ctx.repo,
          issue,
          ctx.trackerUser,
          ctx.ghConfigDir,
          resumed ?? undefined,
        ),
        model: ctx.model,
      }),
    );
    if (launched._tag === "Failure") {
      return {
        ok: false,
        detail: sessionMayExistNote(describe(launched.failure.cause), commandId),
      };
    }
    const { threadId, worktreePath, branch } = launched.success;
    yield* ledger(() =>
      out.append(
        {
          event: "session_launched",
          data: {
            thread_id: threadId,
            worktree: worktreePath,
            branch,
            model_instance: ctx.model.instanceId,
            model: ctx.model.model,
            resumed_from:
              resumed === null ? null : { run: runIdToString(resumed.run), branch: resumed.branch },
          },
        },
        makeCause("start", resumed === null ? "session-launched" : "resumed-from-branch"),
      ),
    );
    return { ok: true, threadId, worktree: worktreePath };
  });

/** The run before `run` and its ledger lines; null for a first attempt or an earlier run with no ledger. */
const previousRun = (
  ctx: StartContext,
  run: RunId,
): Effect.Effect<
  { readonly id: RunId; readonly entries: ReadonlyArray<Entry> } | null,
  LedgerError
> =>
  Effect.gen(function* () {
    if (run.attempt < 2) return null;
    const id = newRunId(run.repo, run.issue, run.attempt - 1);
    const record = yield* ledger(() => readRun(ctx.dataDir, id)).pipe(
      Effect.catchTags({ LedgerNotFoundError: () => Effect.succeed(null) }),
    );
    return record === null ? null : { id, entries: record.entries };
  });

/**
 * The resume a `launch-sending resumed-from <branch>` step decided, for a launch sent again. The
 * words of the first message are the same as the first send's: what the earlier attempt ended
 * with is in its ledger, which does not change.
 */
const recordedResume = (
  ctx: StartContext,
  run: RunId,
  branch: string,
): Effect.Effect<ResumeFrom, LedgerError> =>
  Effect.gen(function* () {
    const previous = yield* previousRun(ctx, run);
    return {
      run: previous?.id ?? newRunId(run.repo, run.issue, Math.max(1, run.attempt - 1)),
      branch,
      after: (previous === null ? null : continuation(previous.entries)?.after) ?? "time-limit",
    };
  });

/**
 * What the new attempt `run` continues from, when the attempt before it stopped at its time limit
 * or was relaunched after an interruption, and the work it left can be found: the earlier run and
 * the branch its session worked on (see `continuation`). Null for a plain start from `base`: a
 * first attempt, a run that stopped for another reason or recorded no branch, one whose branch is
 * not a plain ref name, one whose issue text was edited or renamed since the earlier run's
 * approval (the earlier work was built on other words), or one whose branch GitHub does not have.
 *
 * `origin` is the only source of the work: the branch must be there (`branchTip`, a commit),
 * never in a worktree or the local clone, so a resume on another machine of the fleet works the
 * same. A lookup that fails in any other way, of the text or of the branch, is an error: nothing
 * is launched, the issue stays in `triage`, and the next pass asks again.
 */
const resumeFrom = (
  ctx: StartContext,
  run: RunId,
  issue: number,
): Effect.Effect<ResumeFrom | null, StartError> =>
  Effect.gen(function* () {
    const previous = yield* previousRun(ctx, run);
    if (previous === null) return null;
    const found = continuation(previous.entries);
    // The branch goes to GitHub's ref path and to T3's git as a ref: only a name that can be one
    // argument and not an option is resumed from.
    if (found === null || !isPlainRefName(found.branch)) return null;
    const approvedAt = readProgress(previous.entries).approvedAt;
    if (approvedAt === null) return null;
    if (yield* ctx.tracker.textEditedSince(issue, approvedAt)) return null;
    const tip = yield* Effect.result(ctx.tracker.branchTip(found.branch));
    if (tip._tag === "Success") return { run: previous.id, ...found };
    if (isNotFound(tip.failure)) return null;
    return yield* tip.failure;
  });

/** Whether `name` can go into a ref the factory passes to git: not empty, not an option, no whitespace or control character, no `..`. */
const isPlainRefName = (name: string): boolean =>
  name !== "" && !name.startsWith("-") && !name.includes("..") && !/[\s\p{Cc}]/u.test(name);

/**
 * What the attempt before the new one left for it, from its ledger: the branch its session worked
 * on and why the next attempt continues from it. Null when it left nothing to continue from: it
 * did not stop at its time limit and was not relaunched, or it recorded no branch. A launch sent
 * again reads it too, so the words of both sends are the same.
 *
 * A time-limit stop (its `stuck` line has the reason `time-limit`) wins over a relaunch. Its
 * branch is the one on the `session_launched` line, or, as that line is written when T3 answers
 * the launch and usually before the worktree exists, the one the `stuck` line recorded from the
 * thread. A relaunch's branch is the one on its newest `session_interrupted` line with
 * `relaunch`. An attempt that finished as `needs-info` left nothing to continue from, whatever it
 * did before: its questions end it, and the next attempt starts from base.
 */
const continuation = (
  entries: ReadonlyArray<Entry>,
): { readonly branch: string; readonly after: ResumeAfter } | null => {
  if (entries.some((e) => e.event === "finished" && field(e.data, "outcome") === "needs-info")) {
    return null;
  }
  const branchOn = (event: string, entry: Entry): string | null => {
    const branch = entry.event === event ? field(entry.data, "branch") : undefined;
    return typeof branch === "string" ? branch : null;
  };
  if (entries.some((e) => e.event === "stuck" && e.cause?.reason === "time-limit")) {
    const launched = entries.map((e) => branchOn("session_launched", e)).find((b) => b !== null);
    const recorded = entries.map((e) => branchOn("stuck", e)).findLast((b) => b !== null);
    const branch = launched ?? recorded ?? null;
    return branch === null ? null : { branch, after: "time-limit" };
  }
  const relaunch = entries.findLast(
    (e) => e.event === "session_interrupted" && field(e.data, "relaunch") === true,
  );
  const branch = relaunch === undefined ? null : branchOn("session_interrupted", relaunch);
  return branch === null ? null : { branch, after: "interrupted" };
};

/**
 * The unfinished runs of the issue before attempt `below` that `wanted` keeps, oldest first
 * (softfac's `unfinished_runs`). While the gate of any run it keeps is running, none of them is
 * touched (`GateRunningError`).
 */
const unfinishedRuns = (
  ctx: StartContext,
  issue: number,
  below: number,
  wanted: (seen: Seen) => boolean,
): Effect.Effect<Array<{ id: RunId; seen: Seen }>, LedgerError | GateRunningError> =>
  Effect.gen(function* () {
    const runs: Array<{ id: RunId; seen: Seen }> = [];
    for (let attempt = 1; attempt < below; attempt += 1) {
      const id = newRunId(ctx.repo, String(issue), attempt);
      const record = yield* ledger(() => readRun(ctx.dataDir, id)).pipe(
        Effect.catchTags({ LedgerNotFoundError: () => Effect.succeed(null) }),
      );
      if (record === null) continue;
      const seen = readProgress(record.entries);
      if (seen.finished || !wanted(seen)) continue;
      if (NodeFS.existsSync(gateLockFile(ctx.dataDir, id))) {
        return yield* new GateRunningError({ run: id });
      }
      runs.push({ id, seen });
    }
    return runs;
  });

/**
 * Finishes every unfinished run of the issue before attempt `below`, by its last state, so it is
 * not polled again and cannot write to an issue a newer attempt now owns. While the gate of any
 * of them is running, none of them is finished. A run that names a session or a pull request is
 * finished in the ledger only: nothing is archived or drafted.
 */
const finishOlderRuns = (
  ctx: StartContext,
  issue: number,
  below: number,
  appliedBy: string | null,
): Effect.Effect<void, LedgerError | GateRunningError> =>
  Effect.gen(function* () {
    const older = yield* unfinishedRuns(ctx, issue, below, () => true);
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

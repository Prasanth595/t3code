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
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { ProjectConfig } from "../config.ts";
import { refusalReason, unapprovedComment, type Refusal } from "../domain/approval.ts";
import { issueBase } from "../domain/base.ts";
import { InvalidTransition, stateLabel, transition } from "../domain/lifecycle.ts";
import { gateLockFile } from "../gate.ts";
import { ledgerCall as ledger, type LedgerError } from "../ledger/errors.ts";
import {
  makeCause,
  type Cause,
  type CauseStep,
  type ClaimRepair,
  type Outcome,
} from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { MachineLog } from "../ledger/machineLog.ts";
import { field, readRun, type Entry } from "../ledger/read.ts";
import { asciiLower, newRunId, nextAttempt, runIdToString, type RunId } from "../ledger/runId.ts";
import { formatTs } from "../ledger/time.ts";
import { isUtcSecond } from "../tracker/approvalHistory.ts";
import {
  isBranchPath,
  isNotFound,
  type BoundGitHub,
  type OpenPullRequest,
  type GitHubError,
  type IssueDetail,
} from "../tracker/github.ts";
import type {
  FactoryProject,
  FactorySessions,
  MessageRejectedError,
  SessionsError,
  ThreadNotFoundError,
} from "../t3/sessions.ts";
import {
  CANNOT_CONFIRM,
  CUT_SHORT_COMMENT,
  LAUNCH_FAILED,
  TEXT_CHANGED,
  baseNotABranch,
  baseNotOnOrigin,
  launchMessage,
  sessionMayExistNote,
  type EarlierRunResume,
  type ExistingPrResume,
} from "./messages.ts";
import { launchable } from "./launchTarget.ts";
import { isSafeBranchName } from "./relaunch.ts";
import {
  APPROVAL_RECHECKED,
  LAUNCH_BASE,
  LAUNCH_SENDING,
  LAUNCH_SENDING_PULL_REQUEST,
  LAUNCH_SENDING_RESUMED,
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
  | "openPullRequestsClosing"
>;

/** The runs of an issue before `run` that have a ledger, oldest first, with their lines. */
export const earlierRuns = Effect.fn("RunnerStart.earlierRuns")(function* (
  dataDir: string,
  run: RunId,
): Effect.fn.Return<
  Array<{ readonly id: RunId; readonly entries: ReadonlyArray<Entry> }>,
  LedgerError
> {
  const runs: Array<{ id: RunId; entries: ReadonlyArray<Entry> }> = [];
  for (let attempt = 1; attempt < run.attempt; attempt += 1) {
    const id = newRunId(run.repo, run.issue, attempt);
    const record = yield* ledger(() => readRun(dataDir, id)).pipe(
      Effect.catchTags({ LedgerNotFoundError: () => Effect.succeed(null) }),
    );
    if (record !== null) runs.push({ id, entries: record.entries });
  }
  return runs;
});

/** Whether the factory's own login (`user`, matched without case) opened `pull`. */
export const isOwnPull = (pull: { readonly author: string | null }, user: string): boolean =>
  pull.author !== null && asciiLower(pull.author) === asciiLower(user);

/**
 * Whether a session can be launched onto `pull` and told to push to its branch: it is in this
 * repo, merges into `base`, and its head is a name a command can be handed (`isSafeBranchName`:
 * the head goes into the launch message's `git push`).
 */
export const isResumablePull = (
  pull: { readonly crossRepository: boolean; readonly baseRef: string; readonly headRef: string },
  base: string,
): boolean => !pull.crossRepository && pull.baseRef === base && isSafeBranchName(pull.headRef);

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

export const start = Effect.fn("RunnerStart.start")(function* (
  ctx: StartContext,
  issue: number,
): Effect.fn.Return<StartOutcome, StartError, never> {
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
export const resume = Effect.fn("RunnerStart.resume")(function* (
  ctx: StartContext,
  issue: number,
): Effect.fn.Return<StartOutcome, StartError, never> {
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
const abandonClosed = Effect.fn("RunnerStart.abandonClosed")(function* (
  ctx: StartContext,
  issue: number,
): Effect.fn.Return<StartOutcome, StartError> {
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
const goOn = Effect.fn("RunnerStart.goOn")(function* (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
): Effect.fn.Return<StartOutcome, StartError> {
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
const stuckCutShort = Effect.fn("RunnerStart.stuckCutShort")(function* (
  ctx: StartContext,
  issue: number,
): Effect.fn.Return<boolean, LedgerError> {
  const next = nextAttempt(ctx.dataDir, ctx.repo, String(issue));
  if (next === 1) return false;
  const newest = newRunId(ctx.repo, String(issue), next - 1);
  const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, newest))).entries);
  return !seen.finished && seen.stuck !== null && (seen.state === null || seen.state === "triage");
});

const startFresh = Effect.fn("RunnerStart.startFresh")(function* (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
): Effect.fn.Return<StartOutcome, StartError> {
  // Before the claim: nothing is written for an issue that is not approved except the
  // explanation.
  const approval = yield* ctx.tracker.approval(issue, ctx.project.instructors);
  if (approval.kind === "refused") return yield* refuseStart(ctx, issue, approval.refusal);
  const { labeledAt, labeledBy } = approval;
  // Also before the claim: with T3 out of reach nothing is claimed, so no issue is left in
  // `triage` for a launch that cannot be sent.
  const project = yield* ctx.sessions.findProject(ctx.repoPath);
  const run = newRunId(ctx.repo, String(issue), nextAttempt(ctx.dataDir, ctx.repo, String(issue)));
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
    yield* recordApproval(out, labeledAt, labeledBy === "" ? null : labeledBy, "start");
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
const repairClaim = Effect.fn("RunnerStart.repairClaim")(function* (
  ctx: StartContext,
  issue: number,
  error: GitHubError,
): Effect.fn.Return<{ readonly kind: "claimed" }, GitHubError> {
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
const refuseStart = Effect.fn("RunnerStart.refuseStart")(function* (
  ctx: StartContext,
  issue: number,
  refusal: Refusal,
): Effect.fn.Return<StartOutcome, GitHubError | InvalidTransition> {
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

const resumeStart = Effect.fn("RunnerStart.resumeStart")(function* (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
): Effect.fn.Return<StartOutcome, StartError> {
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
const begin = Effect.fn("RunnerStart.begin")(function* (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
  run: RunId,
  out: Ledger,
  project: FactoryProject | null | undefined,
): Effect.fn.Return<StartOutcome, StartError> {
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
        reason: launched.reason ?? LAUNCH_FAILED,
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

/** A launch not sent or refused. `reason` is the public line when it is not `LAUNCH_FAILED`. */
type Launch =
  | { readonly ok: true; readonly threadId: string; readonly worktree: string | null }
  | { readonly ok: false; readonly detail: string; readonly reason?: string };

/**
 * Sends the launch: `launch-sending` is written once per run, before the first call, so a
 * launch that fails on our side is known to have been sent. The command id comes from the run,
 * so sending it again returns the thread T3 already made. In-process, every failure of the call
 * is T3's answer after the request went out: it is final, and a session may exist. A launch that
 * was never sent (no project) says so only when an earlier pass did send one.
 *
 * What the launch starts from is decided once, before the first call (`resumeFrom`, which asks
 * GitHub), and the step records it: `launch-sending` for a start from `base`,
 * `launch-sending resumed-from <branch>` for a resume from an earlier run's branch, and
 * `launch-sending resumed-from <branch> pull-request <url>` for a resume onto an earlier
 * attempt's open pull request. A call sent again reuses the recorded decision and asks GitHub
 * nothing, so every request under the one command id is the same request, the one T3 acted on,
 * and the ledger's `resumed_from` says what the thread T3 answers with was really made from.
 *
 * The run's base is the issue's `## Base` when it names a branch, else `factory.base` (see
 * `runBase`), decided once like the resume: a named base is in the `launch-base <branch>` step
 * before `launch-sending`, and a call sent again reads it from there. The `session_launched`
 * line records the base for every later pass. A plain start from a named base starts from its
 * tip on `origin`.
 */
const launchSession = Effect.fn("RunnerStart.launchSession")(function* (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
  run: RunId,
  out: Ledger,
  seen: Seen,
  found: FactoryProject | null | undefined,
): Effect.fn.Return<Launch, StartError> {
  const commandId = `softfac:${runIdToString(run)}:launch`;
  const target = launchable(
    found === undefined ? yield* ctx.sessions.findProject(ctx.repoPath) : found,
  );
  if (Result.isFailure(target)) {
    const missing = target.failure;
    return {
      ok: false,
      detail: seen.launchSent ? sessionMayExistNote(missing, commandId) : missing,
    };
  }
  const project = target.success;
  // A launch sent again keeps the base the first send was decided on.
  const based = seen.launchSent
    ? ({ ok: true, base: seen.launchBase ?? ctx.project.base } as const)
    : yield* runBase(ctx, detail);
  if (!based.ok) return { ok: false, reason: based.reason, detail: based.reason };
  const base = based.base;
  const named = base !== ctx.project.base;
  const resumed = seen.launchSent
    ? seen.launchResumedFrom === null
      ? null
      : yield* recordedResume(ctx, run, seen.launchResumedFrom, seen.launchResumedPr)
    : yield* resumeFrom(ctx, run, issue, base);
  if (!seen.launchSent) {
    if (named) {
      yield* ledger(() =>
        out.append(
          { event: "step_changed", data: { step: `${LAUNCH_BASE}${base}` } },
          makeCause("start", "launch-sending"),
        ),
      );
    }
    yield* ledger(() =>
      out.append(
        {
          event: "step_changed",
          data: { step: resumed === null ? LAUNCH_SENDING : resumeStep(resumed) },
        },
        makeCause("start", "launch-sending"),
      ),
    );
  }
  const launched = yield* Effect.result(
    ctx.sessions.launch({
      commandId,
      projectId: project.id,
      title: `${ctx.repo}#${issue} ${detail.title}`,
      baseRef: resumed === null ? base : resumed.branch,
      startFromOrigin: resumed !== null || named,
      message: launchMessage(
        ctx.repo,
        issue,
        ctx.trackerUser,
        ctx.ghConfigDir,
        resumed ?? undefined,
        named ? base : undefined,
      ),
      model: project.model,
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
          model_instance: project.model.instanceId,
          model: project.model.model,
          model_options: project.model.options ?? null,
          resumed_from:
            resumed === null ? null : { run: runIdToString(resumed.run), branch: resumed.branch },
          base,
        },
      },
      makeCause("start", resumed === null ? "session-launched" : "resumed-from-branch"),
    ),
  );
  return { ok: true, threadId, worktree: worktreePath };
});

/**
 * The first line of an attempt's ledger, the `approved <labeled_at>` step: what the attempt was
 * approved on, for the text checks that come later, with the instructor whose label it was
 * (`actor` on the cause) when the approval names one. The claim writes it for the run it starts;
 * a relaunch writes the same line for the next attempt, carrying this run's approval over.
 */
export const recordApproval = (
  out: Ledger,
  labeledAt: string,
  labeledBy: string | null,
  step: CauseStep,
): Effect.Effect<void, LedgerError> =>
  ledger(() =>
    out.append(
      { event: "step_changed", data: { step: `approved ${labeledAt}` } },
      makeCause(step, "approved", labeledBy === null ? {} : { actor: labeledBy }),
    ),
  );

/** The run before `run` and its ledger lines; null for a first attempt or an earlier run with no ledger. */
export const previousRun = Effect.fn("RunnerStart.previousRun")(function* (
  ctx: StartContext,
  run: RunId,
) {
  if (run.attempt < 2) return null;
  const id = newRunId(run.repo, run.issue, run.attempt - 1);
  const record = yield* ledger(() => readRun(ctx.dataDir, id)).pipe(
    Effect.catchTags({ LedgerNotFoundError: () => Effect.succeed(null) }),
  );
  return record === null ? null : { id, entries: record.entries };
});

/**
 * What a launch continues from, with the run its `session_launched` line names as `resumed_from`:
 * the earlier attempt whose branch it continues, or, for an open pull request, this run itself,
 * as a re-gate's session names it: the session pushes to the pull request's branch, not to T3's
 * own (`regateBranch`), and the line reads the same on every machine, whether or not the
 * attempt that opened the pull request left a ledger here.
 */
type Resumed = EarlierRunResume | (ExistingPrResume & { readonly run: RunId });

/** The `launch-sending` step that records the decision `resumed`, read back by `recordedResume`. */
const resumeStep = (resumed: Resumed): string =>
  resumed.after === "existing-pr"
    ? `${LAUNCH_SENDING_RESUMED}${resumed.branch}${LAUNCH_SENDING_PULL_REQUEST}${resumed.prUrl}`
    : `${LAUNCH_SENDING_RESUMED}${resumed.branch}`;

/**
 * The resume a `launch-sending resumed-from <branch>` step decided, for a launch sent again. The
 * words of the first message are the same as the first send's: what the earlier attempt ended
 * with is in its ledger, which does not change, and a pull request the step names is in the step.
 */
const recordedResume = Effect.fn("RunnerStart.recordedResume")(function* (
  ctx: StartContext,
  run: RunId,
  branch: string,
  prUrl: string | null,
): Effect.fn.Return<Resumed, LedgerError> {
  if (prUrl !== null) return { after: "existing-pr", branch, prUrl, run };
  const previous = yield* previousRun(ctx, run);
  return {
    run: previous?.id ?? newRunId(run.repo, run.issue, Math.max(1, run.attempt - 1)),
    branch,
    after: (previous === null ? null : continuation(previous.entries)?.after) ?? "time-limit",
  };
});

/**
 * What the new attempt `run` continues from. First the issue's open pull request, when an earlier
 * attempt left one (`existingPullRequest`): whatever ended that attempt, and whether or not the
 * issue text changed since, the pull request is the work, and a start from `base` beside it
 * would open a second one. Then, when the attempt before `run` stopped at its time limit or was
 * relaunched after an interruption and the work it left can be found: the earlier run and the
 * branch its session worked on (see `continuation`). Null for a plain start from `base`: a
 * first attempt, a run that stopped for another reason or recorded no branch, one whose branch is
 * not a plain ref name, one whose issue text was edited or renamed since the earlier run's
 * approval (the earlier work was built on other words), or one whose branch GitHub does not have.
 *
 * `origin` is the only source of the work: the branch must be there (`branchTip`, a commit, or an
 * open pull request on it), never in a worktree or the local clone, so a resume on another
 * machine of the fleet works the same. A lookup that fails in any other way, of the text or of
 * the branch, is an error: nothing is launched, the issue stays in `triage`, and the next pass
 * asks again.
 */
const resumeFrom = Effect.fn("RunnerStart.resumeFrom")(function* (
  ctx: StartContext,
  run: RunId,
  issue: number,
  base: string,
): Effect.fn.Return<Resumed | null, StartError> {
  const earlier = yield* earlierRuns(ctx.dataDir, run);
  const pull = yield* existingPullRequest(ctx, earlier, issue, base);
  if (pull !== null) return { after: "existing-pr", branch: pull.branch, prUrl: pull.url, run };
  const previous = earlier.find((found) => found.id.attempt === run.attempt - 1);
  if (previous === undefined) return null;
  const found = continuation(previous.entries);
  // The branch goes to GitHub's ref path, to T3's git as a ref, and into the `git push` the
  // launch message tells the session to run: only a plain branch name is resumed from.
  if (found === null || !isSafeBranchName(found.branch)) return null;
  const approvedAt = readProgress(previous.entries).approvedAt;
  if (approvedAt === null) return null;
  if (yield* ctx.tracker.textEditedSince(issue, approvedAt)) return null;
  const tip = yield* Effect.result(ctx.tracker.branchTip(found.branch));
  if (tip._tag === "Success") return { run: previous.id, ...found };
  if (isNotFound(tip.failure)) return null;
  return yield* tip.failure;
});

/**
 * The open pull request an earlier attempt of the issue left, if any, and its branch. The ledger
 * first: the newest `pr_opened` of each of the `earlier` runs, newest attempt first, when GitHub
 * still has that pull request open in this repo onto `base` on a branch a session can be told to
 * push to (`isResumablePull`; a pull request the ledger names was bound to its session when it
 * was written, so nothing asks who opened it). Then GitHub, for an attempt on another machine or
 * a ledger that never recorded one: the newest open pull request that says it closes the issue
 * (the receipt starts with `Closes #n`) by the factory's own login, resumable the same way. GitHub
 * links that only for a pull request onto its default branch, so a run on another base is found
 * through the ledger alone. Null when there is none.
 */
const existingPullRequest = Effect.fn("RunnerStart.existingPullRequest")(function* (
  ctx: StartContext,
  earlier: ReadonlyArray<{ readonly entries: ReadonlyArray<Entry> }>,
  issue: number,
  base: string,
): Effect.fn.Return<{ readonly branch: string; readonly url: string } | null, StartError> {
  for (const { entries } of [...earlier].reverse()) {
    const last = readProgress(entries).lastPr;
    if (last === null) continue;
    const pull = yield* ctx.tracker.pullRequest(last.pr);
    if (pull !== null && pull.open && isResumablePull(pull, base)) {
      return { branch: pull.headRef, url: last.url };
    }
  }
  const own = (yield* ctx.tracker.openPullRequestsClosing(issue)).filter(
    (pull) => isOwnPull(pull, ctx.trackerUser) && isResumablePull(pull, base),
  );
  const newest = own.reduce<OpenPullRequest | null>(
    (best, pull) => (best === null || pull.number > best.number ? pull : best),
    null,
  );
  return newest === null ? null : { branch: newest.headRef, url: newest.url };
});

/**
 * The branch the run lands on: the issue's `## Base` (`issueBase`), else `factory.base`. A named
 * branch must be a plain ref name and be on `origin` (`branchTip`); either failing is a refusal
 * with its public reason. A lookup that fails in any other way is an error, and the next pass
 * asks again.
 */
const runBase = Effect.fn("RunnerStart.runBase")(function* (
  ctx: StartContext,
  detail: IssueDetail,
) {
  const named = issueBase(detail.body);
  if (named === null || named === ctx.project.base) {
    return { ok: true, base: ctx.project.base } as const;
  }
  if (!isPlainRefName(named) || !isBranchPath(named)) {
    return { ok: false, reason: baseNotABranch(named) } as const;
  }
  const tip = yield* Effect.result(ctx.tracker.branchTip(named));
  if (tip._tag === "Success") return { ok: true, base: named } as const;
  // A name the tracker refuses is not a branch name either, whatever rule refused it.
  if (tip.failure._tag === "GitHubInvalidArgument") {
    return { ok: false, reason: baseNotABranch(named) } as const;
  }
  if (isNotFound(tip.failure)) return { ok: false, reason: baseNotOnOrigin(named) } as const;
  return yield* tip.failure;
});

/** Whether `name` can go into a ref the factory passes to git: not empty, not an option, no whitespace or control character, no `..`. */
export const isPlainRefName = (name: string): boolean =>
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
 * thread. A relaunch's branch is the one on its newest `session_interrupted` line, when that is a
 * relaunch (`Seen.interruption`). An attempt that finished as `needs-info` left nothing to
 * continue from, whatever it did before: its questions end it, and the next attempt starts from
 * base.
 */
const continuation = (
  entries: ReadonlyArray<Entry>,
): { readonly branch: string; readonly after: "time-limit" | "interrupted" } | null => {
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
  const relaunch = readProgress(entries).interruption;
  const branch = relaunch !== null && relaunch.relaunch ? relaunch.branch : null;
  return branch === null ? null : { branch, after: "interrupted" };
};

/**
 * The unfinished runs of the issue before attempt `below` that `wanted` keeps, oldest first
 * (softfac's `unfinished_runs`). While the gate of any run it keeps is running, none of them is
 * touched (`GateRunningError`).
 */
const unfinishedRuns = Effect.fn("RunnerStart.unfinishedRuns")(function* (
  ctx: StartContext,
  issue: number,
  below: number,
  wanted: (seen: Seen) => boolean,
) {
  const runs: Array<{ id: RunId; seen: Seen }> = [];
  const earlier = yield* earlierRuns(ctx.dataDir, newRunId(ctx.repo, String(issue), below));
  for (const { id, entries } of earlier) {
    const seen = readProgress(entries);
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
const finishOlderRuns = Effect.fn("RunnerStart.finishOlderRuns")(function* (
  ctx: StartContext,
  issue: number,
  below: number,
  appliedBy: string | null,
) {
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

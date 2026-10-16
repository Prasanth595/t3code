/**
 * One pass of the factory: the project config and tracker login of every watched repo, every
 * unfinished run, the claims that have no run, then new issues. Ported from softfac's `tick.rs`
 * (`run_keeping`, `load_repos`, `runs`, `untracked_claims`, `unassigned_claims` and `claim`) up
 * to the claim; the steps that follow a run (issues #16 to #20) and the dry run are not here.
 *
 * Pure over `PassWorld`: every read and write goes through it, so the tests script a world and
 * `index.ts` builds the live one. Every line goes to `out` as it is decided. Each pass writes
 * `pass_started` first and `pass_finished` last to the machine log.
 */
import * as Effect from "effect/Effect";

import type { HandPause } from "./claims.ts";
import type { MachineConfig, ProjectConfig, WatchedRepo } from "./config.ts";
import { stateLabel, type State } from "./domain/lifecycle.ts";
import { sanitize } from "./gate.ts";
import type { LedgerError } from "./ledger/errors.ts";
import type { ErrorKind, MachineEvent } from "./ledger/events.ts";
import { holdsSlot, type RunInfo } from "./ledger/listRuns.ts";
import { asciiLower, runIdToString, type RunId } from "./ledger/runId.ts";
import { duration, formatTs } from "./ledger/time.ts";
import { mention, type StartError, type StartOutcome } from "./runner/start.ts";
import { LIST_LIMIT, type Blocker, type Listing, type UnassignedClaim } from "./tracker/github.ts";

/** An error of the pass's own: what kind it is for the machine log, and what it says. */
export interface PassError {
  readonly kind: ErrorKind;
  readonly message: string;
}

/** A watched repo with its project config and the login its tracker knows the factory by. */
export interface Repo {
  readonly watched: WatchedRepo;
  readonly project: ProjectConfig;
  readonly trackerUser: string;
}

/** A watched repo, with its config or without it. */
export type Loaded =
  | { readonly kind: "ready"; readonly repo: Repo }
  /** The name of a repo that could not be loaded, already reported. */
  | { readonly kind: "broken"; readonly name: string };

/** Everything a pass reads and writes. */
export interface PassWorld {
  /** The repo's project config, from `.dw/config.yml` at the tip of its default branch. */
  readonly project: (repo: WatchedRepo) => Effect.Effect<ProjectConfig, PassError>;
  /** The login the repo's tracker knows the factory by. */
  readonly trackerUser: (repo: WatchedRepo) => Effect.Effect<string, PassError>;
  /** Every run that is not finished, oldest first; with `only`, the runs of that one issue. */
  readonly unfinishedRuns: (only?: {
    readonly repo: string;
    readonly issue: number;
  }) => Effect.Effect<ReadonlyArray<RunInfo>, LedgerError>;
  /** The open `factory:ready` issues nobody is assigned to, and whether the listing was cut. */
  readonly readyIssues: (repo: Repo) => Effect.Effect<Listing<number>, PassError>;
  /** The open `factory:triage` issues the factory's login is the only assignee of. */
  readonly triageIssues: (repo: Repo) => Effect.Effect<Listing<number>, PassError>;
  /** The claims of this factory's that were cut short: see `unassignedClaims` on the tracker. */
  readonly unassignedClaims: (
    repo: Repo,
  ) => Effect.Effect<ReadonlyArray<UnassignedClaim>, PassError>;
  /** Moves a claim that was cut short to `factory:proposed`, with the cut-short comment. */
  readonly releaseClaim: (repo: Repo, issue: number, from: State) => Effect.Effect<void, PassError>;
  /** The open issues the tracker marks as blocking the issue. */
  readonly openBlockers: (
    repo: Repo,
    issue: number,
  ) => Effect.Effect<ReadonlyArray<Blocker>, PassError>;
  /** The open issues the issue's `## Depends on` text names. */
  readonly dependsOnBlockers: (
    repo: Repo,
    issue: number,
  ) => Effect.Effect<ReadonlyArray<Blocker>, PassError>;
  /** The claim: `runner/start.ts`. */
  readonly start: (repo: Repo, issue: number) => Effect.Effect<StartOutcome, StartError>;
  /** The claim gone on with, never made: `resume` in `runner/start.ts`. */
  readonly resume: (repo: Repo, issue: number) => Effect.Effect<StartOutcome, StartError>;
  /** Whether the run's gate is running now. */
  readonly gateRunning: (run: RunId) => boolean;
  /** Appends an `error` line to the run's own ledger. */
  readonly recordError: (
    run: RunId,
    step: "pass" | "start",
    kind: ErrorKind,
    message: string,
  ) => Effect.Effect<void, LedgerError>;
  /** The claims pause a person made, when there is one. */
  readonly handPause: () => HandPause | null;
  readonly nowMs: () => number;
  /** Writes one event to the machine log. */
  readonly record: (event: MachineEvent) => Effect.Effect<void, LedgerError>;
}

/** The counts the pass prints in its last line. */
export interface Report {
  runs: number;
  claimed: number;
  errors: number;
  attention: number;
}

/** What the pass has to say about one issue, collected as its steps go and printed at the end. */
interface Notes {
  readonly label: string;
  readonly state: string;
  readonly parts: Array<string>;
  readonly errors: Array<NoteError>;
}

/** An error, as printed and as recorded. */
interface NoteError {
  /** The error line, without its `error: ` prefix. */
  readonly line: string;
  readonly step: "pass" | "start";
  readonly kind: ErrorKind;
  /** What went wrong, before it is cleaned for the ledger. */
  readonly message: string;
}

/** `text` with nothing in it that could drive a terminal or hide text. */
const plain = (text: string): string => sanitize(text, false);

/** An error of the pass's own, in the words `what` and `detail`. */
const passError = (kind: ErrorKind, what: string, detail: string): NoteError => ({
  line: `${plain(what)}${plain(detail)}`,
  step: "pass",
  kind,
  message: `${what}${detail}`,
});

/** Every call `start` makes is a tracker call, whatever host the tracker runs on. */
const errorKind = (error: StartError): ErrorKind => {
  switch (error._tag) {
    case "GitHubSpawnError":
    case "GitHubInvalidArgument":
    case "GitHubFailed":
    case "GitHubTimedOut":
    case "GitHubOutputTooLarge":
    case "GitHubParse":
    case "GitHubRateLimited":
      return "tracker";
    case "GateRunningError":
      return "gate";
    case "FactorySessionsError":
      return "t3";
    default:
      // The run's own record disagrees with what the step expected.
      return "ledger";
  }
};

/** Repos match as run ids do: `owner/name` folded with `asciiLower`. */
const sameRepo = (a: string, b: string) => asciiLower(a) === asciiLower(b);

const GATE_RUNNING = "gate running";

const FROM_TEXT = " (from Depends on, add the GitHub link)";

/** `blocked by #13, acme/widgets#7`: a blocker in the repo being claimed from is written by its number alone. */
const blockedBy = (repo: string, blockers: ReadonlyArray<Blocker>, suffix: string): string =>
  `blocked by ${blockers
    .map((b) =>
      sameRepo(b.repo, repo)
        ? `${mention(b.number)}${suffix}`
        : `${plain(b.repo)}${mention(b.number)}${suffix}`,
    )
    .join(", ")}`;

const plural = (n: number, one: string) => (n === 1 ? one : `${one}s`);

/** The machine log's text limit, as softfac prepares session text: cleaned, trimmed, cut. */
const SESSION_TEXT_LIMIT = 4000;
const prepareText = (text: string): string => {
  const trimmed = text.replaceAll("\r\n", "\n").trim();
  const chars = Array.from(trimmed);
  const cut =
    chars.length > SESSION_TEXT_LIMIT
      ? `${chars.slice(0, SESSION_TEXT_LIMIT).join("")}\n[cut]`
      : trimmed;
  return sanitize(cut, true);
};

/** A pass in flight: the counts, the lines, and whether the machine log has failed once. */
class Pass {
  readonly report: Report = { runs: 0, claimed: 0, errors: 0, attention: 0 };
  private logFailed = false;
  private readonly world: PassWorld;
  private readonly out: (line: string) => void;

  constructor(world: PassWorld, out: (line: string) => void) {
    this.world = world;
    this.out = out;
  }

  line(text: string): void {
    this.out(text);
  }

  error(text: string): void {
    this.report.errors += 1;
    this.out(`error: ${text}`);
  }

  /**
   * A line a person has to act on about `run`, and the machine log's `attention` event for it
   * with the ledger.md `reason` code.
   */
  attention(text: string, run: string, reason: string): Effect.Effect<void> {
    this.report.attention += 1;
    this.out(`ATTENTION: ${text}`);
    return this.record({ event: "attention", data: { run, reason } });
  }

  /**
   * Writes `event` to the machine log. A log that cannot be written is an error line once per
   * pass and nothing else: it is not an event, which could not be written either.
   */
  record(event: MachineEvent): Effect.Effect<void> {
    return this.world.record(event).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (this.logFailed) return;
          this.logFailed = true;
          this.error(`machine log: ${plain(error.message)}`);
        }),
      ),
    );
  }

  /**
   * Prints `error` as an error line and records it: as an `error` line in the ledger of `run`
   * when there is one that can take it, in the machine log otherwise (with the run's id when a
   * run's ledger could not take it). `unreadable` is a run whose own ledger cannot be read.
   */
  fail(run: RunId | null, error: NoteError, unreadable = false): Effect.Effect<void> {
    this.error(error.line);
    const message = prepareText(error.message);
    const toMachineLog = (id: string | null) =>
      this.record({
        event: "error",
        data: { ...(id === null ? {} : { run: id }), step: error.step, kind: error.kind, message },
      });
    if (run === null) return toMachineLog(null);
    if (unreadable) return toMachineLog(runIdToString(run));
    return this.world
      .recordError(run, error.step, error.kind, message)
      .pipe(Effect.catch(() => toMachineLog(runIdToString(run))));
  }

  notes(label: string, state: State | null): Notes {
    return { label: plain(label), state: state ?? "starting", parts: [], errors: [] };
  }

  /** The step `name` failed for this issue. */
  failed(notes: Notes, name: string, error: StartError): void {
    notes.errors.push({
      line: `${notes.label} ${name}: ${plain(error.message)}`,
      step: name === "start" ? "start" : "pass",
      kind: errorKind(error),
      message: error.message,
    });
  }

  /** An error of the pass's own about this issue, in the words `what` and `detail`. */
  trouble(notes: Notes, kind: ErrorKind, what: string, detail: string): void {
    const error = passError(kind, what, detail);
    notes.errors.push({ ...error, line: `${notes.label} ${error.line}` });
  }

  /** The run ended in `stuck`. The reason is not printed: it can hold text the session or GitHub wrote. */
  stuck(notes: Notes, run: string): void {
    notes.parts.push(`stuck, the reason is in the ledger of run ${run}`);
  }

  flush(notes: Notes, run: RunId | null): Effect.Effect<void> {
    if (notes.parts.length > 0) {
      this.line(`${notes.label} ${notes.state}: ${notes.parts.join(", ")}`);
    }
    return Effect.forEach(notes.errors, (error) => this.fail(run, error), { discard: true });
  }

  sayIfCut(repo: string, state: State, cut: boolean): void {
    if (cut) {
      this.line(
        `${plain(repo)}: more than ${LIST_LIMIT} open ${stateLabel(state)} issues, so the oldest were not read`,
      );
    }
  }
}

/** One pass. Calls `out` with each line as it is decided. */
export const runPass = (
  world: PassWorld,
  machine: MachineConfig,
  out: (line: string) => void,
): Effect.Effect<Report> =>
  Effect.gen(function* () {
    const pass = new Pass(world, out);
    yield* pass.record({ event: "pass_started", data: {} });
    const repos = yield* loadRepos(world, machine, pass);
    // Without the ledger there is no telling how many runs are active, so nothing is claimed.
    const infos = yield* runs(world, pass);
    if (infos !== null) {
      const known = new Known(infos);
      yield* workRuns(world, repos, known, pass);
      yield* untrackedClaims(world, repos, known, pass);
      yield* unassignedClaims(world, repos, known, pass);
      yield* claim(world, repos, known, machine, pass);
    }
    const report = pass.report;
    pass.line(
      `pass done: ${report.runs} runs, ${report.claimed} claimed, ${report.errors} errors, ${report.attention} need attention`,
    );
    yield* pass.record({ event: "pass_finished", data: { ...report } });
    return report;
  });

/**
 * The project config and tracker login of every watched repo. A repo whose config cannot be
 * loaded is reported and its issues are left alone; so is one whose tracker login cannot be read.
 */
const loadRepos = (
  world: PassWorld,
  machine: MachineConfig,
  pass: Pass,
): Effect.Effect<Array<Loaded>> =>
  Effect.gen(function* () {
    const repos: Array<Loaded> = [];
    for (const watched of machine.repos) {
      const project = yield* Effect.result(world.project(watched));
      if (project._tag === "Failure") {
        const message = project.failure.message;
        pass.error(
          `${plain(watched.repo)}: project config not loaded, repo skipped: ${plain(message)}`,
        );
        yield* pass.record({
          event: "repo_skipped",
          data: { repo: watched.repo, reason: "config-not-loaded", message: prepareText(message) },
        });
        repos.push({ kind: "broken", name: watched.repo });
        continue;
      }
      const user = yield* Effect.result(world.trackerUser(watched));
      if (user._tag === "Failure") {
        yield* pass.fail(
          null,
          passError(
            user.failure.kind,
            `${watched.repo}: cannot read the tracker's login: `,
            user.failure.message,
          ),
        );
        repos.push({ kind: "broken", name: watched.repo });
        continue;
      }
      repos.push({
        kind: "ready",
        repo: { watched, project: project.success, trackerUser: user.success },
      });
    }
    return repos;
  });

/** Every unfinished run, counted; a run whose file cannot be read is an error line and counts as active. */
const runs = (world: PassWorld, pass: Pass): Effect.Effect<ReadonlyArray<RunInfo> | null> =>
  Effect.gen(function* () {
    const listed = yield* Effect.result(world.unfinishedRuns());
    if (listed._tag === "Failure") {
      yield* pass.fail(
        null,
        passError("ledger", "cannot read the run ledger: ", listed.failure.message),
      );
      return null;
    }
    for (const info of listed.success) {
      pass.report.runs += 1;
      const id = runIdToString(info.id);
      if (info.unreadable) {
        // Its own ledger is what cannot be read, so the machine log takes the error.
        yield* pass.fail(
          info.id,
          passError(
            "ledger",
            `run ${id}: its ledger file cannot be read, so nothing was done for it and it counts as active`,
            "",
          ),
          true,
        );
        continue;
      }
    }
    return listed.success;
  });

/**
 * Calls `resume` for each confirmed run still in `triage` (or with no state yet), which goes on
 * from its ledger, so a run cut short after the launch was sent is finished and its session
 * never runs on untracked. A run of a repo that is not loaded is left alone. The other states
 * are worked by later steps. It is not a new claim, so it is not counted as one. An issue put
 * back to `ready` is left to the claim step, and its run holds a slot until a claim finishes it.
 */
const workRuns = (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const info of [...known.infos]) {
      if (info.unreadable || !info.confirmed) continue;
      if (info.state !== null && info.state !== "triage") continue;
      const loaded = repos.find(
        (l) => l.kind === "ready" && sameRepo(l.repo.watched.repo, info.id.repo),
      );
      if (loaded === undefined || loaded.kind !== "ready") continue;
      const repo = loaded.repo;
      const name = repo.watched.repo;
      const issue = Number(info.id.issue);
      const notes = pass.notes(`${name}${mention(issue)}`, info.state);
      const outcome = yield* Effect.result(world.resume(repo, issue));
      if (outcome._tag === "Failure") {
        if (outcome.failure._tag === "GateRunningError") notes.parts.push(GATE_RUNNING);
        else pass.failed(notes, "start", outcome.failure);
      } else {
        switch (outcome.success.kind) {
          case "started":
            notes.parts.push("session started, the issue is building");
            break;
          case "stuck":
            pass.stuck(notes, runIdToString(outcome.success.run));
            break;
          case "skipped":
          case "refused": {
            const moved = outcome.success.kind === "skipped" ? outcome.success.moved : undefined;
            if (moved === "ready") notes.parts.push(READY_AGAIN);
            else {
              const run = runIdToString(info.id);
              yield* stalled(pass, notes, run, outcome.success.reason, moved === "closed");
            }
            break;
          }
        }
      }
      yield* known.refresh(world, pass, name, issue);
      yield* pass.flush(notes, info.id);
    }
  });

/**
 * A ready issue the limit holds back only because of its own triage run whose session may be
 * running: only the claim would finish that run (`finishOlderRuns`), so the slot never frees.
 */
const waitsOnItself = (pass: Pass, notes: Notes, run: string): Effect.Effect<void> =>
  pass.attention(
    `${notes.label} run ${run} is not progressing and holds a slot: its issue is ready again, and the new claim waits for a slot this run holds. Put the issue back to \`factory:triage\` assigned to the factory's user so \`start\` can finish this run, or free a slot`,
    run,
    "not-progressing",
  );

const READY_AGAIN = "its issue is ready again, so it is left to the claim step";

/** A confirmed run still in `triage` (or before any state): what `finishOlderRuns` would end. */
const inTriage = (run: RunInfo): boolean =>
  !run.unreadable && run.confirmed && (run.state === null || run.state === "triage");

/**
 * A confirmed run in `triage` that `resume` would not take, for `why`: a person moved or closed
 * its issue, so nothing in the pass will move it, and it holds a slot. softfac's `stalled` words.
 * Nothing finishes a closed issue's run yet, so its line says how to let the start finish it.
 */
const stalled = (
  pass: Pass,
  notes: Notes,
  run: string,
  why: string,
  closed: boolean,
): Effect.Effect<void> => {
  const back =
    "put it back to `factory:triage` assigned to the factory's user so `start` can finish it";
  const advice = closed
    ? `If it was closed by mistake, reopen it and ${back}`
    : `If you moved the issue by hand, ${back}`;
  return pass.attention(
    `${notes.label} run ${run} is not progressing and holds a slot: ${plain(why)}. ${advice}`,
    run,
    "not-progressing",
  );
};

/**
 * The unfinished runs as this pass knows them: listed once at the start of the pass, then the
 * runs of an issue read again after each `start` for it, so the ledger is not listed whole again.
 */
class Known {
  infos: ReadonlyArray<RunInfo>;
  /** An issue's runs could not be read again, so how many runs are active is not known. */
  lost = false;

  constructor(infos: ReadonlyArray<RunInfo>) {
    this.infos = infos;
  }

  of(repo: string, issue: number): ReadonlyArray<RunInfo> {
    return this.infos.filter((i) => i.id.issue === String(issue) && sameRepo(i.id.repo, repo));
  }

  /** Reads the issue's runs again. A ledger that cannot be read is an error line, once a pass. */
  refresh(world: PassWorld, pass: Pass, repo: string, issue: number): Effect.Effect<void> {
    return Effect.matchEffect(world.unfinishedRuns({ repo, issue }), {
      onSuccess: (fresh) =>
        Effect.sync(() => {
          const others = this.infos.filter(
            (i) => !(i.id.issue === String(issue) && sameRepo(i.id.repo, repo)),
          );
          this.infos = [...others, ...fresh];
        }),
      onFailure: (error) => {
        if (this.lost) return Effect.void;
        this.lost = true;
        return pass.fail(null, passError("ledger", "cannot read the run ledger: ", error.message));
      },
    });
  }
}

/**
 * Claims `start` began that left no run it can go on from: the issue is `factory:triage` and
 * assigned to the factory's login alone, and no unfinished run for it is confirmed (`RunInfo`).
 * `resume` finishes such an issue (the design sends it to `stuck`), in the run it left when there
 * is one, so a stuck path cut short is tried again on every pass. They are claims already made,
 * so the limit on new claims does not apply to them.
 */
const untrackedClaims = (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const loaded of repos) {
      if (loaded.kind !== "ready") continue;
      const repo = loaded.repo;
      const name = repo.watched.repo;
      const listing = yield* Effect.result(world.triageIssues(repo));
      if (listing._tag === "Failure") {
        yield* pass.fail(
          null,
          passError("tracker", `${name}: cannot list the triage issues: `, listing.failure.message),
        );
        continue;
      }
      pass.sayIfCut(name, "triage", listing.success.cut);
      for (const issue of listing.success.items) {
        if (known.of(name, issue).some((i) => i.unreadable || i.confirmed)) continue;
        const notes = pass.notes(`${name}${mention(issue)}`, "triage");
        const run = yield* noteStart(world, pass, known, notes, repo, issue, "resume", {
          claimed: (run) => `no run on record, claimed in run ${run}`,
          notTaken: "no run on record, not ours to resume",
          stuck: "no run on record",
        });
        yield* pass.flush(notes, run);
      }
    }
  });

/**
 * Moves claims that were cut short to `factory:proposed`: the issue is `factory:triage` or
 * `factory:building`, nobody is assigned, no unfinished run is for it, and it has not changed for
 * the grace period the tracker applies. An issue that someone is assigned to is not looked at.
 */
const unassignedClaims = (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const loaded of repos) {
      if (loaded.kind !== "ready") continue;
      const repo = loaded.repo;
      const name = repo.watched.repo;
      const issues = yield* Effect.result(world.unassignedClaims(repo));
      if (issues._tag === "Failure") {
        yield* pass.fail(
          null,
          passError(
            "tracker",
            `${name}: cannot list the unassigned claims: `,
            issues.failure.message,
          ),
        );
        continue;
      }
      for (const { issue, state } of issues.success) {
        if (known.of(name, issue).length > 0) continue;
        const notes = pass.notes(`${name}${mention(issue)}`, state);
        const released = yield* Effect.result(world.releaseClaim(repo, issue, state));
        if (released._tag === "Success") {
          notes.parts.push("no run on record and no assignee, moved to proposed");
          yield* pass.record({
            event: "claim_repaired",
            data: { repo: name, issue: String(issue), outcome: "reconciled" },
          });
        } else {
          pass.trouble(notes, "tracker", "cannot move it to proposed: ", released.failure.message);
        }
        yield* pass.flush(notes, null);
      }
    }
  });

/** The newest of the issue's unfinished runs, or null when there is none. */
const newestRun = (runs: ReadonlyArray<RunInfo>): RunId | null =>
  runs
    .map((info) => info.id)
    .reduce<RunId | null>(
      (best, id) => (best === null || id.attempt > best.attempt ? id : best),
      null,
    );

/**
 * The run a `start` that failed made: the newest unfinished one after the call when it is a newer
 * attempt than `before`, the newest before the call. A failed start may have made a run or
 * reopened the newest, so only a run that is new belongs to the failure.
 */
const madeSince = (after: RunId | null, before: RunId | null): RunId | null =>
  after !== null && (before === null || after.attempt > before.attempt) ? after : null;

/** The words a start's outcome puts on the issue's line, by outcome. */
interface StartWords {
  readonly claimed: (run: string) => string;
  readonly notTaken: string;
  readonly stuck: string;
}

/**
 * Calls `call` (`start`, or `resume` for a claim already made) for the issue and puts what it
 * did on `notes`: the run it names, when it made one, is the run the notes' errors belong to.
 * The issue's runs are read again into `known` after the call. A refused claim is a
 * `claim_skipped`; a claim counts only when the issue was `ready`.
 */
const noteStart = (
  world: PassWorld,
  pass: Pass,
  known: Known,
  notes: Notes,
  repo: Repo,
  issue: number,
  call: "start" | "resume",
  words: StartWords,
): Effect.Effect<RunId | null> =>
  Effect.gen(function* () {
    const name = repo.watched.repo;
    const before = newestRun(known.of(name, issue));
    const outcome = yield* Effect.result(world[call](repo, issue));
    if (outcome._tag === "Failure" && outcome.failure._tag === "GateRunningError") {
      // Nothing was called or written.
      notes.parts.push(GATE_RUNNING);
      return null;
    }
    yield* known.refresh(world, pass, name, issue);
    if (outcome._tag === "Failure") {
      pass.failed(notes, "start", outcome.failure);
      return madeSince(newestRun(known.of(name, issue)), before);
    }
    switch (outcome.success.kind) {
      case "started": {
        const run = runIdToString(outcome.success.run);
        notes.parts.push(words.claimed(run));
        if (notes.state === "ready") pass.report.claimed += 1;
        return outcome.success.run;
      }
      case "skipped":
        notes.parts.push(words.notTaken);
        return null;
      case "refused":
        notes.parts.push(words.notTaken);
        if (notes.state === "ready") {
          yield* pass.record({
            event: "claim_skipped",
            data: { repo: name, issue: String(issue), reason: "unapproved" },
          });
        }
        return null;
      case "stuck": {
        const run = runIdToString(outcome.success.run);
        notes.parts.push(words.stuck);
        pass.stuck(notes, run);
        return outcome.success.run;
      }
    }
  });

/** A watched repo's ready issues still to try this pass, oldest first, and how many of its runs hold a slot. */
interface Queue {
  readonly repo: Repo;
  readonly issues: Array<number>;
  held: number;
}

/** Sets each queue's `held` from the runs that hold a slot, and returns the machine's count. */
const count = (known: Known, queues: ReadonlyArray<Queue>): number => {
  const holding = known.infos.filter(holdsSlot).map((run) => run.id.repo);
  for (const queue of queues) {
    queue.held = holding.filter((repo) => sameRepo(repo, queue.repo.watched.repo)).length;
  }
  return holding.length;
};

/**
 * Claims `factory:ready` issues with `start` while fewer than `max_concurrent_runs` runs are
 * active on the machine. Each claim goes to the repo with the fewest runs holding a slot among
 * the repos that still have a ready issue to try, the one listed first in the machine config on
 * a tie, and the runs are counted again after every claim, so free slots spread across the
 * repos. Within a repo the issues go by number, which is the order they were opened in.
 */
const claim = (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  machine: MachineConfig,
  pass: Pass,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // A start before this step left runs that could not be read again.
    if (known.lost) return;
    const paused = world.handPause();
    // Ready issues that were not tried because the limit was reached. Every repo is still
    // listed, so the count is the whole machine's.
    let left = 0;
    const queues: Array<Queue> = [];
    for (const loaded of repos) {
      if (loaded.kind !== "ready") continue;
      const repo = loaded.repo;
      const name = repo.watched.repo;
      const listing = yield* Effect.result(world.readyIssues(repo));
      if (listing._tag === "Failure") {
        yield* pass.fail(
          null,
          passError("tracker", `${name}: cannot list the ready issues: `, listing.failure.message),
        );
        continue;
      }
      pass.sayIfCut(name, "ready", listing.success.cut);
      // GitHub numbers go by number, which is the order they were opened in.
      const issues = [...new Set(listing.success.items)].sort((a, b) => a - b);
      queues.push({ repo, issues, held: 0 });
    }
    let active = count(known, queues);
    // A blocked issue takes no slot, so its repo stays the one with the fewest and its next
    // issue is tried.
    for (;;) {
      const queue = queues
        .filter((q) => q.issues.length > 0)
        .reduce<Queue | null>((best, q) => (best === null || q.held < best.held ? q : best), null);
      if (queue === null) break;
      const repo = queue.repo;
      const name = repo.watched.repo;
      const issue = queue.issues.shift()!;
      const notes = pass.notes(`${name}${mention(issue)}`, "ready");
      // An issue with a run whose gate is running waits: `start` would finish that run under
      // its gate. It takes no slot, no blocker read, and is not counted as left over.
      const gating = known.of(name, issue).some((info) => world.gateRunning(info.id));
      if (gating) {
        notes.parts.push(GATE_RUNNING);
        yield* pass.flush(notes, null);
        continue;
      }
      // Checked before the blockers: a person paused claims, so no claim is started. The pause is
      // the machine's, said once after the loop.
      if (paused !== null) continue;
      // Before the blockers: with no slot free nothing is claimed, so they are not read. Every
      // issue left is counted as left over, blocked or not. The issue's own triage runs end with
      // this claim (`finishOlderRuns`). One with no session leaves nothing running, so its slot is
      // the claim's; one whose session may be running keeps its slot, so no second session
      // starts past the limit.
      const own = known.of(name, issue).filter(inTriage);
      const freed = own.filter((run) => !run.session).length;
      if (active - freed >= machine.maxConcurrentRuns) {
        left += 1;
        yield* pass.record({
          event: "claim_skipped",
          data: { repo: name, issue: String(issue), reason: "limit" },
        });
        // Its own running sessions fill the limit alone: when every other run frees its slot,
        // the claim still waits, and only the claim would end them.
        const running = own.filter((run) => run.session);
        if (running.length > 0 && running.length >= machine.maxConcurrentRuns) {
          yield* waitsOnItself(pass, notes, runIdToString(running[0]!.id));
        }
        continue;
      }
      // A blocked issue takes no slot. Nothing is written for it, and a read that fails holds it
      // back too. The `## Depends on` text is read only when no linked blocker is open.
      const linked = yield* Effect.result(world.openBlockers(repo, issue));
      if (linked._tag === "Failure") {
        pass.trouble(
          notes,
          "tracker",
          "cannot read the issue's dependencies: ",
          linked.failure.message,
        );
        yield* pass.flush(notes, null);
        continue;
      }
      let blocked: string | null = null;
      if (linked.success.length > 0) {
        blocked = blockedBy(name, linked.success, "");
      } else {
        const text = yield* Effect.result(world.dependsOnBlockers(repo, issue));
        if (text._tag === "Failure") {
          pass.trouble(
            notes,
            "tracker",
            "cannot read the issue's Depends on: ",
            text.failure.message,
          );
          yield* pass.flush(notes, null);
          continue;
        }
        if (text.success.length > 0) blocked = blockedBy(name, text.success, FROM_TEXT);
      }
      if (blocked !== null) {
        notes.parts.push(blocked);
        yield* pass.flush(notes, null);
        yield* pass.record({
          event: "claim_skipped",
          data: { repo: name, issue: String(issue), reason: "blocked" },
        });
        continue;
      }
      const run = yield* noteStart(world, pass, known, notes, repo, issue, "start", {
        claimed: (run) => `claimed, session started in run ${run}`,
        notTaken: "not claimed",
        stuck: "claimed, but the launch failed",
      });
      yield* pass.flush(notes, run);
      if (known.lost) return;
      // Count again: a claim that ended in `stuck`, or in an error that left the issue in
      // `triage`, changes how many runs are active, and which repo has the fewest.
      active = count(known, queues);
    }
    if (paused !== null) {
      pass.line(
        `claims paused: by hand since ${formatTs(paused.sinceMs)}, for ${duration(Math.max(0, world.nowMs() - paused.sinceMs))}; no ready issue claimed`,
      );
      yield* pass.record({ event: "claim_skipped", data: { reason: "paused" } });
    }
    if (left > 0) {
      pass.line(
        `limit reached: ${left} ready ${plural(left, "issue")} ${left === 1 ? "was" : "were"} not claimed, max_concurrent_runs is ${machine.maxConcurrentRuns}`,
      );
    }
  });

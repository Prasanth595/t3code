/**
 * softfac's tick tests for the claims (`src/tick/tests.rs`: claiming new issues, which repo gets
 * a free slot, claims with no run, the limit, the blockers, the hand pause, and what the pass
 * records), ported over a scripted world. Lines that softfac's launch wrote are adapted to the
 * claim this issue stops at.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import type { HandPause } from "./claims.ts";
import { timeLimitOnlyProjectConfig, type MachineConfig, type ProjectConfig } from "./config.ts";
import type { State } from "./domain/lifecycle.ts";
import { LedgerIoError } from "./ledger/errors.ts";
import type { ErrorKind, MachineEvent } from "./ledger/events.ts";
import type { RunInfo } from "./ledger/listRuns.ts";
import { newRunId, runIdToString, type RunId } from "./ledger/runId.ts";
import { formatTs } from "./ledger/time.ts";
import {
  runPass,
  type Loaded,
  type PassError,
  type PassWorld,
  type Repo,
  type Report,
} from "./pass.ts";
import { GateRunningError, type StartError, type StartOutcome } from "./runner/start.ts";
import { SessionsError } from "./t3/sessions.ts";
import { GitHubFailed, type Blocker } from "./tracker/github.ts";

const REPO = "rawphp/softfac";
const OTHER = "rawphp/other";
/** What the fake's clock reads until a test moves it. */
const T0 = 1_791_380_000_000;
const BUILDING: State = "building";

const rid = (issue: number, repo = REPO): RunId => newRunId(repo, String(issue), 1);

const machine = (repos: ReadonlyArray<string>, max: number): MachineConfig => ({
  ghConfigDir: "/gh/rawphp",
  pollSeconds: 60,
  maxConcurrentRuns: max,
  maxConcurrentGates: 2,
  modelInstance: "claudeAgent",
  model: "claude-sonnet-5-5",
  repos: repos.map((repo) => ({ repo, path: `/p/${repo.replace("/", "-")}` })),
});

const project = (): ProjectConfig => ({
  ...timeLimitOnlyProjectConfig(),
  instructors: ["tomkaczocha"],
  base: "main",
  gate: ["cargo test"],
});

const trackerFailure = (): PassError => ({
  kind: "tracker",
  message: "`gh issue list` exited with status 1: boom",
});

const githubFailure = (): StartError =>
  new GitHubFailed({ args: ["issue", "list"], status: 1, stderr: "boom" });

const started = (issue: number, repo = REPO): StartOutcome => ({
  kind: "started",
  run: rid(issue, repo),
  threadId: "thread-1",
});

type Answers<T> = Record<string, T | "error">;

/** Everything the pass can touch, scripted. `calls` logs each call in order. */
class Fake implements PassWorld {
  projects: Record<string, ProjectConfig | string> = {};
  trackerUsers: Record<string, string | { error: string }> = {};
  runs: Array<RunInfo> = [];
  runsError = false;
  ready: Answers<Array<number>> = {};
  readyCut: Array<string> = [];
  triage: Answers<Array<number>> = {};
  triageCut: Array<string> = [];
  unassigned: Answers<Array<{ issue: number; state: State }>> = {};
  releaseFails = false;
  blockers: Answers<Array<Blocker>> = {};
  depends: Answers<Array<Blocker>> = {};
  starts: Record<string, Array<StartOutcome | StartError>> = {};
  /** Issues whose `start` leaves a `triage` run behind, whatever it answers. */
  startLeavesRun: Array<number> = [];
  pause: HandPause | null = null;
  machineLogFails = false;
  /** What the pass wrote to a run's ledger as an `error` line. */
  runErrors: Array<{ run: RunId; step: string; kind: ErrorKind; message: string }> = [];
  /** The next run ledger writes fail: the run's ledger is finished, or cannot be written. */
  runErrorFails = false;
  /** The runs whose gate lock is held, by run id. */
  gateLocks: Array<string> = [];
  now = T0;
  calls: Array<string> = [];
  events: Array<MachineEvent> = [];

  runIn(issue: number, state: State | null, repo = REPO) {
    this.runs.push({ id: rid(issue, repo), state, unreadable: false, confirmed: true });
  }

  pushStart(key: string, answer: StartOutcome | StartError) {
    (this.starts[key] ??= []).push(answer);
  }

  project(watched: { repo: string }) {
    this.calls.push("project");
    const found = this.projects[watched.repo];
    if (typeof found === "string") {
      return Effect.fail<PassError>({ kind: "config", message: found });
    }
    return Effect.succeed(found ?? project());
  }

  trackerUser(watched: { repo: string }) {
    this.calls.push("tracker_user");
    const found = this.trackerUsers[watched.repo];
    if (typeof found === "object") {
      return Effect.fail<PassError>({ kind: "tracker", message: found.error });
    }
    return Effect.succeed(found ?? "rawphp");
  }

  unfinishedRuns(only?: { repo: string; issue: number }) {
    this.calls.push(only === undefined ? "runs" : `runs ${only.repo}#${only.issue}`);
    if (this.runsError) {
      return Effect.fail(new LedgerIoError({ path: "/data/runs", cause: new Error("unreadable") }));
    }
    return Effect.succeed(
      this.runs.filter(
        (run) =>
          only === undefined ||
          (run.id.issue === String(only.issue) &&
            run.id.repo.toLowerCase() === only.repo.toLowerCase()),
      ),
    );
  }

  private listing(answers: Answers<Array<number>>, cut: Array<string>, repo: Repo) {
    const found = answers[repo.watched.repo];
    if (found === "error") return Effect.fail(trackerFailure());
    return Effect.succeed({ items: found ?? [], cut: cut.includes(repo.watched.repo) });
  }

  readyIssues(repo: Repo) {
    this.calls.push("ready");
    return this.listing(this.ready, this.readyCut, repo);
  }

  triageIssues(repo: Repo) {
    this.calls.push("triage");
    return this.listing(this.triage, this.triageCut, repo);
  }

  unassignedClaims(repo: Repo) {
    const found = this.unassigned[repo.watched.repo];
    if (found === "error") return Effect.fail(trackerFailure());
    return Effect.succeed(found ?? []);
  }

  releaseClaim(repo: Repo, issue: number, from: State) {
    this.calls.push(`release ${repo.watched.repo}#${issue} ${from}`);
    return this.releaseFails ? Effect.fail(trackerFailure()) : Effect.void;
  }

  private blockerRead(answers: Answers<Array<Blocker>>, name: string, repo: Repo, issue: number) {
    const key = `${repo.watched.repo}#${issue}`;
    this.calls.push(`${name} ${key}`);
    const found = answers[key];
    if (found === "error") return Effect.fail(trackerFailure());
    return Effect.succeed(found ?? []);
  }

  openBlockers(repo: Repo, issue: number) {
    return this.blockerRead(this.blockers, "blockers", repo, issue);
  }

  dependsOnBlockers(repo: Repo, issue: number) {
    return this.blockerRead(this.depends, "depends", repo, issue);
  }

  start(repo: Repo, issue: number) {
    return this.answerStart("start", repo, issue);
  }

  resume(repo: Repo, issue: number) {
    return this.answerStart("resume", repo, issue);
  }

  /** Both calls share one script per issue; `calls` says which was made. */
  private answerStart(call: "start" | "resume", repo: Repo, issue: number) {
    const key = `${repo.watched.repo}#${issue}`;
    this.calls.push(`${call} ${key}`);
    const answer = this.starts[key]?.shift() ?? { kind: "skipped", reason: "scripted" };
    if (this.startLeavesRun.includes(issue)) {
      this.runs.push({
        id: rid(issue, repo.watched.repo),
        state: "triage",
        unreadable: false,
        confirmed: true,
      });
    }
    if ("kind" in answer && answer.kind === "started") {
      const existing = this.runs.find((r) => runIdToString(r.id) === runIdToString(answer.run));
      // A run the pass already knew moves on to building; a new claim leaves a triage run.
      if (existing !== undefined)
        this.runs[this.runs.indexOf(existing)] = { ...existing, state: "building" };
      else this.runs.push({ id: answer.run, state: "triage", unreadable: false, confirmed: true });
      return Effect.succeed(answer);
    }
    if ("kind" in answer) return Effect.succeed(answer);
    return Effect.fail(answer);
  }

  handPause() {
    return this.pause;
  }

  nowMs() {
    return this.now;
  }

  recordError(run: RunId, step: "pass" | "start", kind: ErrorKind, message: string) {
    if (this.runErrorFails) {
      return Effect.fail(
        new LedgerIoError({ path: "/data/runs/x.jsonl", cause: new Error("finished") }),
      );
    }
    this.runErrors.push({ run, step, kind, message });
    return Effect.void;
  }

  gateRunning(run: RunId) {
    return this.gateLocks.includes(runIdToString(run));
  }

  record(event: MachineEvent) {
    if (this.machineLogFails) {
      return Effect.fail(
        new LedgerIoError({ path: "/data/events.jsonl", cause: new Error("disk full") }),
      );
    }
    this.events.push(event);
    return Effect.void;
  }
}

const pass = (
  fake: Fake,
  config: MachineConfig,
): Effect.Effect<{ report: Report; lines: Array<string> }> =>
  Effect.gen(function* () {
    const lines: Array<string> = [];
    const report = yield* runPass(fake, config, (line) => lines.push(line));
    return { report, lines };
  });

/** The `start` and `resume` calls, in order. */
const starts = (fake: Fake) =>
  fake.calls.filter((c) => c.startsWith("start ") || c.startsWith("resume "));
const releases = (fake: Fake) => fake.calls.filter((c) => c.startsWith("release "));

const runLine = (lines: ReadonlyArray<string>, prefix: string): string => {
  const line = lines.find((l) => l.startsWith(prefix));
  assert.ok(line !== undefined, `no line starting ${prefix} in ${JSON.stringify(lines, null, 2)}`);
  return line;
};

const blockerList = (by: ReadonlyArray<readonly [string, number]>): Array<Blocker> =>
  by.map(([repo, number]) => ({ repo, number }));

const claimSkipped = (issue: number, reason: string, repo = REPO): MachineEvent => ({
  event: "claim_skipped",
  data: { repo, issue: String(issue), reason },
});

const errorEvents = (fake: Fake) => fake.events.filter((e) => e.event === "error");
const recordedErrorKinds = (fake: Fake): Array<ErrorKind> =>
  errorEvents(fake).map((e) => (e.data as { kind: ErrorKind }).kind);

const FROM_TEXT = " (from Depends on, add the GitHub link)";

// ---- claiming new issues ----

describe("claiming new issues", () => {
  it.effect("ready issues are claimed oldest first", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      // By number, not by text: 10 comes after 9.
      fake.ready[REPO] = [10, 9, 3, 5];
      for (const issue of [3, 5, 9, 10]) fake.pushStart(`${REPO}#${issue}`, started(issue));
      const { report } = yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(starts(fake), [
        `start ${REPO}#3`,
        `start ${REPO}#5`,
        `start ${REPO}#9`,
        `start ${REPO}#10`,
      ]);
      assert.equal(report.claimed, 4);
    }),
  );

  it.effect("no more issues are claimed than max_concurrent_runs allows", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2, 3];
      for (const issue of [1, 2, 3]) fake.pushStart(`${REPO}#${issue}`, started(issue));
      yield* pass(fake, machine([REPO], 2));
      assert.deepEqual(starts(fake), [`start ${REPO}#1`, `start ${REPO}#2`]);
    }),
  );

  it.effect("runs that are already active use up the slots", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      fake.ready[REPO] = [1];
      yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(starts(fake), []);
    }),
  );

  it.effect("a run in any watched repo uses a slot", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(8, BUILDING, OTHER);
      fake.ready[REPO] = [1];
      yield* pass(fake, machine([REPO, OTHER], 1));
      assert.deepEqual(starts(fake), []);
    }),
  );

  it.effect("an issue that was not claimed does not use a slot", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2];
      // Issue 1 gets the default skipped.
      fake.pushStart(`${REPO}#2`, started(2));
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.equal(starts(fake).length, 2);
      assert.equal(report.claimed, 1);
      assert.equal(runLine(lines, "rawphp/softfac#1 "), "rawphp/softfac#1 ready: not claimed");
    }),
  );

  it.effect("a claimed issue gets a line naming its run", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [2];
      fake.pushStart(`${REPO}#2`, started(2));
      const { lines } = yield* pass(fake, machine([REPO], 1));
      assert.equal(
        runLine(lines, "rawphp/softfac#2 "),
        "rawphp/softfac#2 ready: claimed, session started in run rawphp__softfac__2__1",
      );
    }),
  );

  it.effect("a failed start is an error line and the next issue is tried", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2];
      fake.pushStart(`${REPO}#1`, githubFailure());
      fake.pushStart(`${REPO}#2`, started(2));
      const { report, lines } = yield* pass(fake, machine([REPO], 5));
      assert.equal(starts(fake).length, 2);
      assert.deepEqual([report.errors, report.claimed], [1, 1]);
      assert.ok(
        lines.some((l) => l.startsWith("error: rawphp/softfac#1 start:")),
        lines.join("\n"),
      );
      // Every call `start` makes is a tracker call, whatever host the tracker runs on.
      assert.deepEqual(recordedErrorKinds(fake), ["tracker"]);
      assert.deepEqual((errorEvents(fake)[0]!.data as { step: string }).step, "start");
    }),
  );

  it.effect("a claimed issue that went stuck says so and names the run", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [12];
      fake.pushStart(`${REPO}#12`, { kind: "stuck", run: rid(12), reason: "secret detail" });
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.equal(report.claimed, 0);
      const line = runLine(lines, "rawphp/softfac#12 ");
      assert.ok(line.includes("stuck"), line);
      assert.ok(line.includes("claimed, but the launch failed"), line);
      assert.ok(line.includes("rawphp__softfac__12__1"), line);
      assert.ok(!line.includes("secret detail"), line);
    }),
  );

  it.effect("a repo whose ready issues cannot be listed is an error and the others go on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = "error";
      fake.ready[OTHER] = [4];
      fake.pushStart(`${OTHER}#4`, started(4, OTHER));
      const { report, lines } = yield* pass(fake, machine([REPO, OTHER], 3));
      assert.deepEqual(starts(fake), [`start ${OTHER}#4`]);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) => l.startsWith("error: rawphp/softfac: cannot list the ready issues")),
        lines.join("\n"),
      );
      assert.deepEqual(recordedErrorKinds(fake), ["tracker"]);
    }),
  );

  it.effect("a cut ready listing is said once and the issues read are still claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1];
      fake.readyCut = [REPO];
      fake.pushStart(`${REPO}#1`, started(1));
      const { lines } = yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(
        lines.filter((l) => l.includes("more than")),
        ["rawphp/softfac: more than 200 open factory:ready issues, so the oldest were not read"],
      );
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
    }),
  );

  it.effect(
    "a repo whose tracker login cannot be read is logged and skipped, and the others still run",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.trackerUsers[REPO] = { error: "cannot read the login: boom" };
        fake.runIn(12, BUILDING);
        fake.ready[REPO] = [1];
        fake.ready[OTHER] = [4];
        fake.pushStart(`${OTHER}#4`, started(4, OTHER));
        const { report } = yield* pass(fake, machine([REPO, OTHER], 3));
        assert.equal(report.errors, 1);
        assert.deepEqual(starts(fake), [`start ${OTHER}#4`]);
        const errors = errorEvents(fake);
        assert.equal(errors.length, 1);
        assert.deepEqual(errors[0]!.data, {
          step: "pass",
          kind: "tracker",
          message: "rawphp/softfac: cannot read the tracker's login: cannot read the login: boom",
        });
      }),
  );

  it.effect("a repo whose config cannot be loaded is reported and skipped while others go on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = "no .dw/config.yml on main";
      fake.runIn(12, BUILDING);
      fake.ready[REPO] = [1];
      fake.ready[OTHER] = [4];
      fake.pushStart(`${OTHER}#4`, started(4, OTHER));
      const { report, lines } = yield* pass(fake, machine([REPO, OTHER], 3));
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some(
          (l) =>
            l.startsWith("error: rawphp/softfac: project config not loaded") &&
            l.includes("no .dw/config.yml on main"),
        ),
        lines.join("\n"),
      );
      assert.deepEqual(starts(fake), [`start ${OTHER}#4`]);
      assert.ok(
        fake.events.some(
          (e) =>
            e.event === "repo_skipped" &&
            e.data.repo === REPO &&
            e.data.reason === "config-not-loaded" &&
            e.data.message === "no .dw/config.yml on main",
        ),
        JSON.stringify(fake.events),
      );
    }),
  );

  it.effect("a ledger that cannot be listed is an error and nothing is claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runsError = true;
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      const { report, lines } = yield* pass(fake, machine([REPO], 3));
      assert.deepEqual(starts(fake), []);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) => l.startsWith("error: cannot read the run ledger")),
        lines.join("\n"),
      );
      assert.deepEqual(recordedErrorKinds(fake), ["ledger"]);
    }),
  );

  it.effect("a run whose file cannot be read is an error line and counts as active", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runs.push({ id: rid(40), state: null, unreadable: true, confirmed: false });
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(starts(fake), []);
      assert.equal(report.runs, 1);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) =>
          l.startsWith("error: run rawphp__softfac__40__1: its ledger file cannot be read"),
        ),
        lines.join("\n"),
      );
      assert.deepEqual(
        errorEvents(fake).map((e) => (e.data as { run?: string }).run),
        ["rawphp__softfac__40__1"],
      );
    }),
  );
});

// ---- a ready issue whose older run is gating ----

describe("a ready issue whose older run is gating", () => {
  it.effect("is not claimed again, says gate running, and is neither blocked nor held back", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(14, BUILDING);
      fake.gateLocks = [runIdToString(rid(14))];
      fake.ready[REPO] = [14, 15];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(starts(fake), []);
      assert.equal(runLine(lines, "rawphp/softfac#14 "), "rawphp/softfac#14 ready: gate running");
      assert.ok(!fake.calls.includes("blockers rawphp/softfac#14"), fake.calls.join("\n"));
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [claimSkipped(15, "limit")],
      );
      assert.ok(
        lines.includes("limit reached: 1 ready issue was not claimed, max_concurrent_runs is 1"),
      );
      assert.equal(report.errors, 0);
    }),
  );

  it.effect("a start that finds a gate running says so and is no error", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.pushStart(`${REPO}#14`, new GateRunningError({ run: rid(14) }));
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.equal(runLine(lines, "rawphp/softfac#14 "), "rawphp/softfac#14 ready: gate running");
      assert.equal(report.errors, 0);
    }),
  );
});

// ---- which repo gets a free slot ----

describe("which repo gets a free slot", () => {
  it.effect("a free slot goes to the repo with the fewest runs, not the one listed first", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      for (const issue of [40, 41, 42, 43, 44]) fake.runIn(issue, BUILDING);
      fake.ready[REPO] = [1, 2, 3];
      fake.ready[OTHER] = [7];
      for (const issue of [1, 2, 3]) fake.pushStart(`${REPO}#${issue}`, started(issue));
      fake.pushStart(`${OTHER}#7`, started(7, OTHER));
      yield* pass(fake, machine([REPO, OTHER], 6));
      assert.deepEqual(starts(fake), [`start ${OTHER}#7`]);
    }),
  );

  it.effect("repos with as many runs each get their oldest issue, the first listed first", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [2, 1];
      fake.ready[OTHER] = [4, 3];
      for (const [repo, issue] of [
        [REPO, 1],
        [REPO, 2],
        [OTHER, 3],
        [OTHER, 4],
      ] as const) {
        fake.pushStart(`${repo}#${issue}`, started(issue, repo));
      }
      yield* pass(fake, machine([REPO, OTHER], 2));
      assert.deepEqual(starts(fake), [`start ${REPO}#1`, `start ${OTHER}#3`]);
    }),
  );

  it.effect("the runs are counted again after every claim, so the slots spread", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2, 3];
      fake.ready[OTHER] = [4, 5];
      for (const [repo, issue] of [
        [REPO, 1],
        [REPO, 2],
        [REPO, 3],
        [OTHER, 4],
        [OTHER, 5],
      ] as const) {
        fake.pushStart(`${repo}#${issue}`, started(issue, repo));
      }
      yield* pass(fake, machine([REPO, OTHER], 3));
      assert.deepEqual(starts(fake), [`start ${REPO}#1`, `start ${OTHER}#4`, `start ${REPO}#2`]);
    }),
  );

  it.effect(
    "a blocked issue lets the next of its repo be tried, and a pr-open run is not counted",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.runIn(40, BUILDING);
        fake.runIn(41, "pr-open", OTHER);
        fake.ready[REPO] = [1];
        fake.ready[OTHER] = [4, 5];
        fake.blockers[`${OTHER}#4`] = blockerList([[OTHER, 3]]);
        fake.pushStart(`${REPO}#1`, started(1));
        fake.pushStart(`${OTHER}#5`, started(5, OTHER));
        yield* pass(fake, machine([REPO, OTHER], 3));
        assert.deepEqual(starts(fake), [`start ${OTHER}#5`, `start ${REPO}#1`]);
      }),
  );

  it.effect("the runs of a repo listed in mixed case count against it", () =>
    Effect.gen(function* () {
      // A run id holds the repo in lowercase; the machine config may not.
      const other = "RawPhp/Other";
      const fake = new Fake();
      fake.runIn(40, BUILDING, other);
      fake.runIn(41, BUILDING, other);
      fake.runIn(42, BUILDING);
      fake.ready[other] = [7];
      fake.ready[REPO] = [1];
      fake.pushStart(`${other}#7`, started(7, other));
      fake.pushStart(`${REPO}#1`, started(1));
      yield* pass(fake, machine([other, REPO], 4));
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
    }),
  );
});

// ---- runs that are confirmed and still in triage ----

describe("runs that are confirmed and still in triage", () => {
  it.effect("a confirmed triage run is resumed on the next pass, and the line says so", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, started(12));
      const { report, lines } = yield* pass(fake, machine([REPO], 3));
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`]);
      const line = runLine(lines, "rawphp/softfac#12 triage:");
      assert.ok(line.includes("session started, the issue is building"), line);
      assert.equal(report.claimed, 0);
    }),
  );

  it.effect("a confirmed run with no state yet is resumed too", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runs.push({ id: rid(13), state: null, unreadable: false, confirmed: true });
      fake.pushStart(`${REPO}#13`, started(13));
      yield* pass(fake, machine([REPO], 3));
      assert.deepEqual(starts(fake), [`resume ${REPO}#13`]);
    }),
  );

  it.effect("a triage run whose start fails records the error on that run", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, githubFailure());
      const { report } = yield* pass(fake, machine([REPO], 3));
      assert.equal(report.errors, 1);
      assert.equal(fake.runErrors.length, 1);
      assert.deepEqual(fake.runErrors[0]!.run, rid(12));
      assert.equal(fake.runErrors[0]!.step, "start");
    }),
  );

  it.effect("a triage run that went stuck says so and names the run", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, { kind: "stuck", run: rid(12), reason: "secret detail" });
      const { lines } = yield* pass(fake, machine([REPO], 3));
      const line = runLine(lines, "rawphp/softfac#12 ");
      assert.ok(line.includes("stuck"), line);
      assert.ok(line.includes("rawphp__softfac__12__1"), line);
      assert.ok(!line.includes("secret detail"), line);
    }),
  );

  it.effect("a triage run is worked before new issues are claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.ready[REPO] = [3];
      fake.pushStart(`${REPO}#12`, started(12));
      fake.pushStart(`${REPO}#3`, started(3));
      yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`, `start ${REPO}#3`]);
    }),
  );

  it.effect("a ready-again issue whose own run holds the only slot is an attention line", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.ready[REPO] = [12];
      fake.pushStart(`${REPO}#12`, { kind: "skipped", reason: "ready again", moved: "ready" });
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      // `resume` never claims, and the run holds the only slot.
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`]);
      const note = runLine(lines, "rawphp/softfac#12 triage:");
      assert.ok(note.includes("ready again: the claim step takes it when a slot is free"), note);
      assert.equal(report.attention, 1);
      const line = runLine(lines, "ATTENTION: rawphp/softfac#12 ");
      assert.ok(line.includes("the new claim waits for a slot this run holds"), line);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "attention"),
        [
          {
            event: "attention",
            data: { run: "rawphp__softfac__12__1", reason: "not-progressing" },
          },
        ],
      );
    }),
  );

  it.effect("a ready issue the limit holds back by other runs raises no attention", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      fake.ready[REPO] = [3];
      const { report } = yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(starts(fake), []);
      assert.equal(report.attention, 0);
    }),
  );

  it.effect("a triage run whose issue is ready again is claimed afresh when a slot is free", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.ready[REPO] = [12];
      fake.pushStart(`${REPO}#12`, { kind: "skipped", reason: "ready again", moved: "ready" });
      const { report } = yield* pass(fake, machine([REPO], 2));
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`, `start ${REPO}#12`]);
      assert.equal(report.attention, 0);
    }),
  );

  it.effect("a triage run whose issue a person moved is an attention line, logged, with why", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, { kind: "skipped", reason: "issue #12 is assigned to bob" });
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.equal(report.attention, 1);
      const line = runLine(lines, "ATTENTION: rawphp/softfac#12 ");
      assert.ok(
        line.includes(
          "run rawphp__softfac__12__1 is not progressing and holds a slot: issue #12 is assigned to bob. If you moved the issue by hand",
        ),
        line,
      );
      assert.deepEqual(
        fake.events.filter((e) => e.event === "attention"),
        [
          {
            event: "attention",
            data: { run: "rawphp__softfac__12__1", reason: "not-progressing" },
          },
        ],
      );
    }),
  );

  it.effect("a triage run whose issue was closed says to reopen it", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, {
        kind: "skipped",
        reason: "issue #12 is closed",
        moved: "closed",
      });
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.equal(report.attention, 1);
      const line = runLine(lines, "ATTENTION: rawphp/softfac#12 ");
      assert.ok(
        line.includes("holds a slot: issue #12 is closed. If it was closed by mistake, reopen it"),
        line,
      );
    }),
  );

  it.effect("a building run is left alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      yield* pass(fake, machine([REPO], 3));
      assert.deepEqual(starts(fake), []);
    }),
  );

  it.effect("a run of a repo that is not loaded is left alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage", "acme/other");
      const { report } = yield* pass(fake, machine([REPO], 3));
      assert.deepEqual(starts(fake), []);
      assert.equal(report.errors, 0);
    }),
  );

  it.effect("a start that fails at T3 is recorded as a t3 error", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(
        `${REPO}#12`,
        new SessionsError({ operation: "find-project", cause: new Error("down") }),
      );
      yield* pass(fake, machine([REPO], 3));
      assert.equal(fake.runErrors[0]!.kind, "t3");
    }),
  );
});

// ---- claims that have no run in the ledger ----

describe("claims that have no run in the ledger", () => {
  it.effect("a triage issue of ours with no run is resumed, and is not a new claim", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7];
      fake.pushStart(`${REPO}#7`, { kind: "stuck", run: rid(7), reason: "could not confirm" });
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(starts(fake), [`resume ${REPO}#7`]);
      const line = runLine(lines, "rawphp/softfac#7 ");
      assert.ok(line.startsWith("rawphp/softfac#7 triage: no run on record, stuck"), line);
      assert.ok(line.includes("rawphp__softfac__7__1"), line);
      assert.equal(report.claimed, 0);
    }),
  );

  it.effect("a triage issue that has an unfinished run is resumed by the run step alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.triage[REPO] = [12];
      yield* pass(fake, machine([REPO], 3));
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`]);
    }),
  );

  it.effect("a triage issue whose only run is not confirmed is resumed again", () =>
    Effect.gen(function* () {
      // A stuck path that failed half way leaves a run with no approval behind; start finishes it.
      const fake = new Fake();
      fake.runs.push({ id: rid(12), state: "triage", unreadable: false, confirmed: false });
      fake.triage[REPO] = [12];
      fake.pushStart(`${REPO}#12`, { kind: "stuck", run: rid(12), reason: "could not confirm" });
      const { lines } = yield* pass(fake, machine([REPO], 3));
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`]);
      assert.ok(runLine(lines, "rawphp/softfac#12 ").includes("stuck"), lines.join("\n"));
    }),
  );

  it.effect("a run that is not confirmed takes no slot", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runs.push({ id: rid(12), state: "triage", unreadable: false, confirmed: false });
      fake.ready[REPO] = [3];
      fake.pushStart(`${REPO}#3`, started(3));
      yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(starts(fake), [`start ${REPO}#3`]);
    }),
  );

  it.effect("a triage issue with no run is resumed even when every slot is taken", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      fake.triage[REPO] = [7];
      yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(starts(fake), [`resume ${REPO}#7`]);
    }),
  );

  it.effect("a triage issue is resumed before new issues are claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7];
      fake.ready[REPO] = [3];
      fake.pushStart(`${REPO}#7`, started(7));
      fake.pushStart(`${REPO}#3`, started(3));
      yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(starts(fake), [`resume ${REPO}#7`, `start ${REPO}#3`]);
    }),
  );

  it.effect("a triage issue that start leaves alone or fails on is said so", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7, 8];
      fake.pushStart(`${REPO}#8`, githubFailure());
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.equal(starts(fake).length, 2);
      assert.ok(runLine(lines, "rawphp/softfac#7 ").includes("not ours to resume"));
      assert.ok(
        lines.some((l) => l.startsWith("error: rawphp/softfac#8 start:")),
        lines.join("\n"),
      );
      assert.equal(report.errors, 1);
    }),
  );

  it.effect("triage issues that cannot be listed are an error and the others go on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = "error";
      fake.triage[OTHER] = [4];
      const { report, lines } = yield* pass(fake, machine([REPO, OTHER], 1));
      assert.deepEqual(starts(fake), [`resume ${OTHER}#4`]);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) => l.startsWith("error: rawphp/softfac: cannot list the triage issues")),
        lines.join("\n"),
      );
    }),
  );

  it.effect("a cut triage listing is said once", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7];
      fake.triageCut = [REPO];
      const { lines } = yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(
        lines.filter((l) => l.includes("more than")),
        ["rawphp/softfac: more than 200 open factory:triage issues, so the oldest were not read"],
      );
    }),
  );

  it.effect("a repo whose config is broken has its triage issues left alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = "bad";
      fake.triage[REPO] = [7];
      yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(starts(fake), []);
    }),
  );
});

// ---- claims with no run and no assignee ----

describe("claims with no run and no assignee", () => {
  const reconciled = (issue: number): MachineEvent => ({
    event: "claim_repaired",
    data: { repo: REPO, issue: String(issue), outcome: "reconciled" },
  });

  it.effect("a triage or building issue with no run and no assignee is moved to proposed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.unassigned[REPO] = [
        { issue: 7, state: "triage" },
        { issue: 8, state: "building" },
      ];
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.equal(report.errors, 0);
      assert.deepEqual(releases(fake), [`release ${REPO}#7 triage`, `release ${REPO}#8 building`]);
      assert.equal(
        runLine(lines, "rawphp/softfac#7 "),
        "rawphp/softfac#7 triage: no run on record and no assignee, moved to proposed",
      );
      assert.equal(
        runLine(lines, "rawphp/softfac#8 "),
        "rawphp/softfac#8 building: no run on record and no assignee, moved to proposed",
      );
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_repaired"),
        [reconciled(7), reconciled(8)],
      );
    }),
  );

  it.effect("an unassigned issue that has a run is left alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(7, "triage");
      fake.unassigned[REPO] = [
        { issue: 7, state: "triage" },
        { issue: 8, state: "building" },
      ];
      yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(releases(fake), [`release ${REPO}#8 building`]);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_repaired"),
        [reconciled(8)],
      );
    }),
  );

  it.effect("a repo whose config is broken has its unassigned issues left alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = "bad";
      fake.unassigned[REPO] = [{ issue: 7, state: "triage" }];
      yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(releases(fake), []);
    }),
  );

  it.effect("unassigned issues that cannot be listed are an error and the pass goes on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.unassigned[REPO] = "error";
      fake.unassigned[OTHER] = [{ issue: 4, state: "triage" }];
      const { report, lines } = yield* pass(fake, machine([REPO, OTHER], 1));
      assert.equal(report.errors, 1);
      assert.deepEqual(releases(fake), [`release ${OTHER}#4 triage`]);
      const errors = lines.filter((l) => l.startsWith("error: "));
      assert.equal(errors.length, 1, lines.join("\n"));
      assert.ok(
        errors[0]!.startsWith("error: rawphp/softfac: cannot list the unassigned claims: "),
      );
      assert.deepEqual(recordedErrorKinds(fake), ["tracker"]);
    }),
  );

  it.effect("a release that fails is an error and records no repair", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.releaseFails = true;
      fake.unassigned[REPO] = [
        { issue: 7, state: "triage" },
        { issue: 8, state: "triage" },
      ];
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.equal(report.errors, 2);
      assert.equal(releases(fake).length, 2, "the pass goes on to the next");
      assert.ok(
        lines.some((l) => l.startsWith("error: rawphp/softfac#7 ")),
        lines.join("\n"),
      );
      assert.ok(!fake.events.some((e) => e.event === "claim_repaired"));
    }),
  );
});

// ---- issues blocked by an open issue ----

describe("issues blocked by an open issue", () => {
  it.effect("an issue blocked by an open issue is not claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      const { report, lines } = yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(starts(fake), []);
      assert.ok(lines.includes("rawphp/softfac#14 ready: blocked by #13"), lines.join("\n"));
      assert.deepEqual([report.claimed, report.errors], [0, 0]);
      assert.ok(
        fake.events.some((e) => JSON.stringify(e) === JSON.stringify(claimSkipped(14, "blocked"))),
      );
    }),
  );

  it.effect("several blockers are joined, and one in another repo names its repo", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.blockers[`${REPO}#14`] = blockerList([
        [REPO, 13],
        ["acme/widgets", 7],
        ["RawPHP/Softfac", 9],
      ]);
      const { lines } = yield* pass(fake, machine([REPO], 5));
      assert.ok(
        lines.includes("rawphp/softfac#14 ready: blocked by #13, acme/widgets#7, #9"),
        lines.join("\n"),
      );
    }),
  );

  it.effect("a blocked issue uses no slot and the pass goes on to the next", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14, 15];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      fake.pushStart(`${REPO}#15`, started(15));
      const { report } = yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(starts(fake), [`start ${REPO}#15`]);
      assert.equal(report.claimed, 1);
    }),
  );

  it.effect("with no slot free no blockers are read and every issue left is counted", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      fake.ready[REPO] = [14, 15];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      const { lines } = yield* pass(fake, machine([REPO], 1));
      assert.ok(
        lines.includes("limit reached: 2 ready issues were not claimed, max_concurrent_runs is 1"),
        lines.join("\n"),
      );
      assert.deepEqual(
        fake.calls.filter((c) => c.startsWith("blockers ") || c.startsWith("depends ")),
        [],
      );
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [claimSkipped(14, "limit"), claimSkipped(15, "limit")],
      );
    }),
  );

  it.effect("blockers are read only until the last slot is taken", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14, 15, 16];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      fake.pushStart(`${REPO}#15`, started(15));
      yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(
        fake.calls.filter((c) => c.startsWith("blockers ")),
        [`blockers ${REPO}#14`, `blockers ${REPO}#15`],
      );
      assert.deepEqual(starts(fake), [`start ${REPO}#15`]);
    }),
  );

  it.effect("an issue whose blockers cannot be read is not claimed and the pass goes on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14, 15];
      fake.blockers[`${REPO}#14`] = "error";
      fake.pushStart(`${REPO}#15`, started(15));
      const { report, lines } = yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(starts(fake), [`start ${REPO}#15`]);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) =>
          l.startsWith("error: rawphp/softfac#14 cannot read the issue's dependencies: "),
        ),
        lines.join("\n"),
      );
      assert.ok(!fake.events.some((e) => e.event === "claim_skipped"));
    }),
  );

  it.effect("blockers are read only when an issue is about to be claimed", () =>
    Effect.gen(function* () {
      // Runs that have started are not looked at again, and untracked triage claims are already made.
      const fake = new Fake();
      fake.runIn(14, BUILDING);
      fake.triage[REPO] = [7];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      fake.blockers[`${REPO}#7`] = blockerList([[REPO, 13]]);
      fake.depends[`${REPO}#14`] = blockerList([[REPO, 13]]);
      fake.depends[`${REPO}#7`] = blockerList([[REPO, 13]]);
      yield* pass(fake, machine([REPO], 5));
      assert.ok(!fake.calls.some((c) => c.startsWith("blockers")), fake.calls.join("\n"));
      assert.equal(
        fake.calls.filter((c) => c.startsWith("depends")).length,
        0,
        fake.calls.join("\n"),
      );
    }),
  );
});

// ---- issues whose `## Depends on` text names an open issue ----

describe("issues whose Depends on text names an open issue", () => {
  it.effect("an issue whose depends on names an open issue is not claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.depends[`${REPO}#14`] = blockerList([[REPO, 13]]);
      const { report, lines } = yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(starts(fake), []);
      assert.ok(
        lines.includes(`rawphp/softfac#14 ready: blocked by #13${FROM_TEXT}`),
        lines.join("\n"),
      );
      assert.deepEqual([report.claimed, report.errors], [0, 0]);
    }),
  );

  it.effect(
    "each blocker from the text carries the suffix, and one in another repo names its repo",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [14];
        fake.depends[`${REPO}#14`] = blockerList([
          [REPO, 13],
          ["acme/widgets", 7],
        ]);
        const { lines } = yield* pass(fake, machine([REPO], 5));
        assert.ok(
          lines.includes(
            `rawphp/softfac#14 ready: blocked by #13${FROM_TEXT}, acme/widgets#7${FROM_TEXT}`,
          ),
          lines.join("\n"),
        );
      }),
  );

  it.effect("an issue whose depends on names nothing open is claimed as normal", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.depends[`${REPO}#14`] = [];
      fake.pushStart(`${REPO}#14`, started(14));
      const { report } = yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(starts(fake), [`start ${REPO}#14`]);
      assert.equal(report.claimed, 1);
    }),
  );

  it.effect("an issue blocked by a link does not have its depends on read", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      fake.depends[`${REPO}#14`] = blockerList([[REPO, 12]]);
      yield* pass(fake, machine([REPO], 5));
      assert.equal(fake.calls.filter((c) => c.startsWith("depends")).length, 0);
    }),
  );

  it.effect("an issue whose depends on cannot be read is not claimed and the pass goes on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14, 15];
      fake.depends[`${REPO}#14`] = "error";
      fake.pushStart(`${REPO}#15`, started(15));
      const { report, lines } = yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(starts(fake), [`start ${REPO}#15`]);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) =>
          l.startsWith("error: rawphp/softfac#14 cannot read the issue's Depends on: "),
        ),
        lines.join("\n"),
      );
      assert.deepEqual(recordedErrorKinds(fake), ["tracker"]);
    }),
  );

  it.effect("an issue blocked by its text is recorded as a skipped claim", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.depends[`${REPO}#14`] = blockerList([[REPO, 13]]);
      yield* pass(fake, machine([REPO], 5));
      assert.ok(
        fake.events.some((e) => JSON.stringify(e) === JSON.stringify(claimSkipped(14, "blocked"))),
      );
    }),
  );
});

// ---- the limit, said out loud ----

describe("the limit, said out loud", () => {
  const LIMIT_1 = "limit reached: 1 ready issue was not claimed, max_concurrent_runs is 1";

  it.effect("issues left unclaimed because the limit is reached are counted in one line", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      fake.ready[REPO] = [1, 2];
      const { lines } = yield* pass(fake, machine([REPO], 1));
      assert.ok(
        lines.includes("limit reached: 2 ready issues were not claimed, max_concurrent_runs is 1"),
        lines.join("\n"),
      );
      assert.equal(lines.filter((l) => l.startsWith("limit reached")).length, 1);
    }),
  );

  it.effect("the count covers what is left after the slots fill, and the repos after it", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2, 3];
      fake.ready[OTHER] = [4];
      fake.pushStart(`${REPO}#1`, started(1));
      const { lines } = yield* pass(fake, machine([REPO, OTHER], 1));
      assert.ok(
        lines.includes("limit reached: 3 ready issues were not claimed, max_concurrent_runs is 1"),
        lines.join("\n"),
      );
    }),
  );

  it.effect("an issue start skipped before the limit is not counted as left over", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2, 3];
      // 1 is skipped (the default), 2 is claimed, 3 is left.
      fake.pushStart(`${REPO}#2`, started(2));
      const { lines } = yield* pass(fake, machine([REPO], 1));
      assert.ok(lines.includes(LIMIT_1), lines.join("\n"));
    }),
  );

  it.effect("no limit line when every ready issue was tried", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2];
      const { lines } = yield* pass(fake, machine([REPO], 5));
      assert.ok(!lines.some((l) => l.startsWith("limit reached")), lines.join("\n"));
    }),
  );
});

// ---- the hand pause ----

describe("the hand pause", () => {
  /** A person paused claims two hours before the clock of the fake. */
  const pausedByHand = (fake: Fake) => {
    fake.pause = { sinceMs: T0 - 2 * 60 * 60 * 1000 };
  };

  /** The one line of a pass that finds the pause, two hours old. */
  const HAND_PAUSE_LINE = `claims paused: by hand since ${formatTs(T0 - 2 * 60 * 60 * 1000)}, for 2h00m; no ready issue claimed`;

  const handLines = (lines: ReadonlyArray<string>) =>
    lines.filter((l) => l.startsWith("claims paused: by hand"));

  const claimSkippedEvents = (fake: Fake) => fake.events.filter((e) => e.event === "claim_skipped");

  it.effect("with the pause no ready issue of any repo is claimed, and one line says so", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2];
      fake.ready[OTHER] = [4];
      pausedByHand(fake);
      const { report, lines } = yield* pass(fake, machine([REPO, OTHER], 5));
      assert.deepEqual(starts(fake), []);
      assert.ok(!fake.calls.some((c) => c.startsWith("blockers")), fake.calls.join("\n"));
      assert.deepEqual(handLines(lines), [HAND_PAUSE_LINE]);
      assert.deepEqual(claimSkippedEvents(fake), [
        { event: "claim_skipped", data: { reason: "paused" } },
      ]);
      // No line for each issue, no limit.
      assert.ok(!lines.some((l) => l.includes(" ready:")), lines.join("\n"));
      assert.ok(!lines.some((l) => l.startsWith("limit reached")));
      assert.deepEqual([report.claimed, report.attention, report.errors], [0, 0, 0]);
    }),
  );

  it.effect("with the pause a pass with nothing ready still says it once", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pausedByHand(fake);
      const { lines } = yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(handLines(lines), [HAND_PAUSE_LINE]);
      assert.equal(claimSkippedEvents(fake).length, 1);
    }),
  );

  it.effect("with the pause an untracked claim is still handled", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7];
      fake.unassigned[REPO] = [{ issue: 8, state: "triage" }];
      pausedByHand(fake);
      yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(starts(fake), [`resume ${REPO}#7`]);
      assert.deepEqual(releases(fake), [`release ${REPO}#8 triage`]);
    }),
  );

  it.effect(
    "without the pause the same ready issue is claimed and nothing is said of a pause",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [1];
        fake.pushStart(`${REPO}#1`, started(1));
        const { report, lines } = yield* pass(fake, machine([REPO], 5));
        assert.equal(starts(fake).length, 1, fake.calls.join("\n"));
        assert.deepEqual(handLines(lines), []);
        assert.deepEqual(claimSkippedEvents(fake), []);
        assert.equal(report.claimed, 1);
      }),
  );
});

// ---- what the pass records ----

describe("what the pass records", () => {
  it.effect("a pass records its start and the counts it prints", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING);
      fake.runs.push({ id: rid(13), state: null, unreadable: true, confirmed: false });
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(fake.events[0], { event: "pass_started", data: {} });
      assert.deepEqual(fake.events.at(-1), {
        event: "pass_finished",
        data: {
          runs: report.runs,
          claimed: report.claimed,
          errors: report.errors,
          attention: report.attention,
        },
      });
      assert.deepEqual([report.runs, report.errors, report.attention], [2, 1, 0]);
      assert.ok(lines.at(-1)!.startsWith("pass done:"), lines.join("\n"));
    }),
  );

  it.effect("the pass ends with a summary line", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING);
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      const { lines } = yield* pass(fake, machine([REPO], 5));
      assert.equal(lines.at(-1), "pass done: 1 runs, 1 claimed, 0 errors, 0 need attention");
    }),
  );

  it.effect("an issue held back by the limit is recorded with its repo and number", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING);
      fake.ready[REPO] = [5, 6];
      yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [claimSkipped(5, "limit"), claimSkipped(6, "limit")],
      );
    }),
  );

  it.effect("an issue start refused as unapproved is recorded", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [5];
      fake.pushStart(`${REPO}#5`, {
        kind: "refused",
        reason: "issue #5 was not approved: factory:ready was not applied by an instructor",
      });
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.equal(report.claimed, 0);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [claimSkipped(5, "unapproved")],
      );
      assert.ok(
        lines.some((l) => l.includes("rawphp/softfac#5")),
        lines.join("\n"),
      );
    }),
  );

  it.effect("an issue start skipped for another reason is not recorded as a skipped claim", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [5];
      yield* pass(fake, machine([REPO], 1));
      assert.ok(!fake.events.some((e) => e.event === "claim_skipped"));
    }),
  );

  it.effect("a machine log that cannot be written is an error line once and the pass goes on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.machineLogFails = true;
      fake.runIn(12, BUILDING);
      fake.ready[REPO] = [5, 6];
      const { report, lines } = yield* pass(fake, machine([REPO], 1));
      assert.equal(
        lines.filter((l) => l.startsWith("error: machine log:")).length,
        1,
        lines.join("\n"),
      );
      assert.equal(report.errors, 1);
      assert.ok(lines.at(-1)!.startsWith("pass done:"));
    }),
  );

  it.effect(
    "a start that fails after it made a run records the error in that run, with the start step",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [1];
        fake.startLeavesRun = [1];
        fake.pushStart(`${REPO}#1`, githubFailure());
        const { report } = yield* pass(fake, machine([REPO], 1));
        assert.equal(report.errors, 1);
        assert.deepEqual(
          fake.runErrors.map((e) => [runIdToString(e.run), e.step, e.kind]),
          [["rawphp__softfac__1__1", "start", "tracker"]],
        );
        assert.ok(fake.runErrors[0]!.message.includes("boom"));
        assert.deepEqual(errorEvents(fake), []);
      }),
  );

  it.effect(
    "a start that fails before it made a run records the error in the machine log as a start",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [1];
        fake.pushStart(`${REPO}#1`, githubFailure());
        yield* pass(fake, machine([REPO], 1));
        assert.deepEqual(fake.runErrors, []);
        const [error] = errorEvents(fake);
        assert.ok(error !== undefined);
        assert.deepEqual(Object.keys(error.data), ["step", "kind", "message"]);
        assert.equal((error.data as { step: string }).step, "start");
      }),
  );

  it.effect("a start that fails before it made a run does not blame an older unfinished run", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(1, "triage");
      fake.triage[REPO] = [1];
      fake.ready[REPO] = [2];
      fake.pushStart(`${REPO}#2`, githubFailure());
      yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(fake.runErrors, []);
      assert.equal(errorEvents(fake).length, 1);
      assert.equal((errorEvents(fake)[0]!.data as { run?: string }).run, undefined);
    }),
  );

  it.effect(
    "an error for a run whose ledger takes no line goes to the machine log with the run",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [1];
        fake.startLeavesRun = [1];
        fake.runErrorFails = true;
        fake.pushStart(`${REPO}#1`, githubFailure());
        yield* pass(fake, machine([REPO], 1));
        const [error] = errorEvents(fake);
        assert.ok(error !== undefined);
        assert.equal((error.data as { run?: string }).run, "rawphp__softfac__1__1");
        assert.equal((error.data as { step: string }).step, "start");
      }),
  );

  it.effect("the error of a step that fails names its step, kind and message", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1];
      fake.pushStart(
        `${REPO}#1`,
        new LedgerIoError({ path: "/data/runs/x.jsonl", cause: new Error("disk full") }),
      );
      yield* pass(fake, machine([REPO], 1));
      const [error] = errorEvents(fake);
      assert.ok(error !== undefined);
      const data = error.data as { step: string; kind: string; message: string; run?: string };
      assert.equal(data.step, "start");
      assert.equal(data.kind, "ledger");
      assert.ok(data.message.includes("disk full"), data.message);
    }),
  );
});

// ---- reading the ledger ----

describe("reading the ledger", () => {
  it.effect(
    "the ledger is listed whole once a pass, and an issue's runs again after its start",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.triage[REPO] = [7];
        fake.ready[REPO] = [1, 2, 3];
        fake.pushStart(`${REPO}#7`, started(7));
        fake.pushStart(`${REPO}#1`, started(1));
        fake.pushStart(`${REPO}#2`, started(2));
        fake.pushStart(`${REPO}#3`, started(3));
        yield* pass(fake, machine([REPO], 5));
        assert.deepEqual(
          fake.calls.filter((c) => c.startsWith("runs")),
          ["runs", `runs ${REPO}#7`, `runs ${REPO}#1`, `runs ${REPO}#2`, `runs ${REPO}#3`],
        );
      }),
  );

  it.effect("a claim read again counts against the limit", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2];
      fake.pushStart(`${REPO}#1`, started(1));
      fake.pushStart(`${REPO}#2`, started(2));
      const { lines } = yield* pass(fake, machine([REPO], 1));
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
      assert.ok(
        lines.includes("limit reached: 1 ready issue was not claimed, max_concurrent_runs is 1"),
        lines.join("\n"),
      );
    }),
  );

  it.effect("runs that cannot be read again after a start stop the claims, said once", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7, 8];
      fake.ready[REPO] = [1];
      const listed = fake.unfinishedRuns.bind(fake);
      fake.unfinishedRuns = (only) => {
        if (only !== undefined) fake.runsError = true;
        return listed(only);
      };
      const { report, lines } = yield* pass(fake, machine([REPO], 5));
      assert.deepEqual(starts(fake), [`resume ${REPO}#7`, `resume ${REPO}#8`]);
      assert.equal(
        lines.filter((l) => l.startsWith("error: cannot read the run ledger")).length,
        1,
        lines.join("\n"),
      );
      assert.equal(report.errors, 1);
    }),
  );
});

// ---- text that is printed ----

describe("text that is printed", () => {
  it.effect("a repo name from the config is escaped where it is printed", () =>
    Effect.gen(function* () {
      const evil = "rawphp/evil\u001b[31m";
      const fake = new Fake();
      fake.ready[evil] = "error";
      const { lines } = yield* pass(fake, machine([evil], 1));
      const line = runLine(lines, "error: rawphp/evil");
      assert.ok(!line.includes("\u001b"), JSON.stringify(line));
    }),
  );
});

/** The shapes the live world builds, kept in the test so a change to them is seen here. */
const _loaded: Loaded = { kind: "broken", name: REPO };
void _loaded;
void runIdToString;

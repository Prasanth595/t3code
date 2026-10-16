// @effect-diagnostics nodeBuiltinImport:off - the tests read real run files and lay out gate locks.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe } from "vite-plus/test";

import { timeLimitOnlyProjectConfig, type ProjectConfig } from "../config.ts";
import type { Approval } from "../domain/approval.ts";
import { unapprovedComment } from "../domain/approval.ts";
import type { State } from "../domain/lifecycle.ts";
import { gateLockFile } from "../gate.ts";
import { makeCause } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { scanMachineLog } from "../ledger/machineLog.ts";
import { readRun } from "../ledger/read.ts";
import { runPath, type RunId } from "../ledger/runId.ts";
import { T0, useTempDirs } from "../ledger/testSupport.ts";
import {
  GitHubFailed,
  type ClaimOutcome,
  type FactoryComment,
  type GitHubError,
  type IssueDetail,
} from "../tracker/github.ts";
import { CANNOT_CONFIRM, CUT_SHORT_COMMENT, statusBody, stuckComment } from "./messages.ts";
import { GateRunningError, start, type StartOutcome, type Tracker } from "./start.ts";

const tempDir = useTempDirs();

const REPO = "rawphp/softfac";
const USER = "rawphp";
const LABELED = "2026-10-04T10:00:00Z";

const handles: Array<Ledger> = [];
afterEach(() => {
  for (const ledger of handles.splice(0)) ledger.close();
});

const project = (): ProjectConfig => ({
  ...timeLimitOnlyProjectConfig(),
  instructors: ["tomkaczocha"],
  base: "main",
  gate: ["cargo test"],
});

const detail = (
  state: State | null,
  assignees: ReadonlyArray<string> = [],
  closed = false,
): IssueDetail => ({
  number: 7,
  title: "Build step",
  body: "Build the runner.",
  labels: state === null ? [] : [`factory:${state}`],
  assignees,
  author: "tomkaczocha",
  state,
  closed,
});

const ghFailure = () =>
  new GitHubFailed({ args: ["issue", "edit", "7"], status: 1, stderr: "boom" });

/** Scripted answers: each method pops its next answer, or gives the default when none is queued. */
const fakeTracker = (script: {
  issues?: Array<IssueDetail | GitHubError>;
  approval?: Approval;
  claims?: Array<ClaimOutcome | GitHubError>;
  assignFails?: boolean;
  setStateFails?: boolean;
  newestComment?: FactoryComment | null;
}) => {
  const calls: Array<string> = [];
  const issues = [...(script.issues ?? [detail("ready")])];
  const claims = [...(script.claims ?? [{ kind: "claimed" } as const])];
  const answer = <A>(queue: Array<A | GitHubError>, fallback: A) => {
    const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? fallback);
    return next instanceof Object && "_tag" in next && typeof next._tag === "string"
      ? Effect.fail(next as GitHubError)
      : Effect.succeed(next as A);
  };
  const tracker: Tracker = {
    issue: (n) => {
      calls.push(`issue ${n}`);
      return answer(issues, detail("ready"));
    },
    approval: (n, instructors) => {
      calls.push(`approval ${n} ${instructors.join(",")}`);
      return Effect.succeed(
        script.approval ?? { kind: "approved", labeledAt: LABELED, labeledBy: "tomkaczocha" },
      );
    },
    claim: (n, user, from, to) => {
      calls.push(`claim ${n} ${user} ${from}->${to}`);
      return answer(claims, { kind: "claimed" });
    },
    setState: (n, state) => {
      calls.push(`setState ${n} ${state}`);
      return script.setStateFails ? Effect.fail(ghFailure()) : Effect.void;
    },
    assign: (n, user) => {
      calls.push(`assign ${n} ${user}`);
      return script.assignFails ? Effect.fail(ghFailure()) : Effect.void;
    },
    unassign: (n, user) => {
      calls.push(`unassign ${n} ${user}`);
      return Effect.void;
    },
    postComment: (n, body) => {
      calls.push(`comment ${n} ${body}`);
      return Effect.void;
    },
    upsertStatusComment: (n, user, body) => {
      calls.push(`status ${n} ${user} ${body}`);
      return Effect.void;
    },
    newestFactoryComment: (n) => {
      calls.push(`newest ${n}`);
      return Effect.succeed(script.newestComment ?? null);
    },
  };
  return { tracker, calls };
};

const run7: RunId = { repo: REPO, issue: "7", attempt: 1 };

const isGateRunning = Schema.is(GateRunningError);

const ctxFor = (dataDir: string, tracker: Tracker, clock: () => number = () => T0) => ({
  repo: REPO,
  trackerUser: USER,
  machine: "mac-mini",
  project: project(),
  dataDir,
  tracker,
  clock,
});

const startIn = (dataDir: string, tracker: Tracker, clock?: () => number) =>
  start(ctxFor(dataDir, tracker, clock), 7);

const entriesOf = (dataDir: string, id: RunId = run7) =>
  readRun(dataDir, id).entries.map((e) => ({ event: e.event, data: e.data, cause: e.cause }));

const stepsOf = (dataDir: string, id: RunId = run7) =>
  readRun(dataDir, id).entries.map((e) => e.event);

/** An older run of issue 7 whose last state is `to`, with the approval it was claimed on when `approved`. */
const olderRun = (
  dataDir: string,
  attempt: number,
  to: State,
  finish = false,
  approved = false,
) => {
  const id = { ...run7, attempt };
  const ledger = Ledger.create(dataDir, id, { clock: () => T0 - 1000 });
  handles.push(ledger);
  const cause = makeCause("start", "claimed");
  if (approved) {
    ledger.append({ event: "step_changed", data: { step: `approved ${LABELED}` } }, cause);
  }
  ledger.append({ event: "claimed", data: { machine: "m", github_user: USER } }, cause);
  ledger.append({ event: "state_changed", data: { from: "ready", to } }, cause);
  if (finish) ledger.finish("stuck", null, null, cause);
  return id;
};

describe("start: a fresh ready issue", () => {
  it.effect("checks the approval, claims, and records the approval, the claim and the state", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({});
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, { kind: "claimed", run: run7 } satisfies StartOutcome);
      assert.deepStrictEqual(calls, [
        "issue 7",
        "approval 7 tomkaczocha",
        "claim 7 rawphp ready->triage",
      ]);
      assert.deepStrictEqual(entriesOf(dataDir), [
        {
          event: "step_changed",
          data: { step: `approved ${LABELED}` },
          cause: { step: "start", reason: "approved", actor: "tomkaczocha" },
        },
        {
          event: "claimed",
          data: { machine: "mac-mini", github_user: "rawphp" },
          cause: { step: "start", reason: "claimed" },
        },
        {
          event: "state_changed",
          data: { from: "ready", to: "triage" },
          cause: { step: "start", reason: "claimed" },
        },
      ]);
    }),
  );

  it.effect("a refusal posts the comment, moves the issue to proposed and makes no run", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const refusal = { kind: "labeled-by-non-instructor", by: "eve", labeledAt: LABELED } as const;
      const { tracker, calls } = fakeTracker({ approval: { kind: "refused", refusal } });
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, {
        kind: "refused",
        reason: "issue #7 was not approved: factory:ready was not applied by an instructor",
      });
      assert.deepStrictEqual(calls, [
        "issue 7",
        "approval 7 tomkaczocha",
        "newest 7",
        `comment 7 ${unapprovedComment(refusal)}`,
        "setState 7 proposed",
      ]);
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, run7)), false);
    }),
  );

  it.effect("a refusal already explained since the label is not commented again", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const refusal = { kind: "edited-after-label", labeledAt: LABELED } as const;
      const { tracker, calls } = fakeTracker({
        approval: { kind: "refused", refusal },
        newestComment: { body: unapprovedComment(refusal), createdAt: "2026-10-04T10:00:01Z" },
      });
      yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(calls, [
        "issue 7",
        "approval 7 tomkaczocha",
        "newest 7",
        "setState 7 proposed",
      ]);
      // The same comment from before the label is about an earlier refusal: said again.
      const before = fakeTracker({
        approval: { kind: "refused", refusal },
        newestComment: { body: unapprovedComment(refusal), createdAt: "2026-10-04T09:59:59Z" },
      });
      yield* startIn(tempDir(), before.tracker);
      assert.ok(
        before.calls.some((c) => c.startsWith("comment 7 ")),
        before.calls.join("\n"),
      );
    }),
  );

  it.effect("a refusal with no label time is not repeated within an hour", () =>
    Effect.gen(function* () {
      const refusal = { kind: "label-not-found" } as const;
      const recent = fakeTracker({
        approval: { kind: "refused", refusal },
        newestComment: { body: unapprovedComment(refusal), createdAt: "2026-10-04T09:30:00Z" },
      });
      // The clock reads 2026-10-04T10:13:16.123Z: the comment is 43 minutes old.
      yield* startIn(tempDir(), recent.tracker);
      assert.ok(!recent.calls.some((c) => c.startsWith("comment 7 ")), recent.calls.join("\n"));
      const old = fakeTracker({
        approval: { kind: "refused", refusal },
        newestComment: { body: unapprovedComment(refusal), createdAt: "2026-10-04T09:00:00Z" },
      });
      yield* startIn(tempDir(), old.tracker);
      assert.ok(
        old.calls.some((c) => c.startsWith("comment 7 ")),
        old.calls.join("\n"),
      );
    }),
  );

  it.effect("an issue that is assigned, closed or not ready is skipped with nothing written", () =>
    Effect.gen(function* () {
      for (const [issue, reason] of [
        [detail("ready", ["a", "b"]), "issue #7 is already assigned to a, b"],
        [detail("ready", [], true), "issue #7 is closed"],
        [detail("building", [USER]), "issue #7 is not labelled factory:ready"],
        [detail("triage", ["eve"]), "issue #7 is not labelled factory:ready"],
        [detail(null), "issue #7 is not labelled factory:ready"],
      ] as const) {
        const dataDir = tempDir();
        const { tracker, calls } = fakeTracker({ issues: [issue] });
        const outcome = yield* startIn(dataDir, tracker);
        assert.deepStrictEqual(outcome, { kind: "skipped", reason });
        assert.deepStrictEqual(calls, ["issue 7"]);
        assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "runs")), false);
      }
    }),
  );

  it.effect("a claim that finds an assignee is skipped and makes no run", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({ claims: [{ kind: "skipped-assigned", assignees: ["a"] }] });
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, {
        kind: "skipped",
        reason: "issue #7 is already assigned to a",
      });
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, run7)), false);
    }),
  );
});

describe("start: a claim call that fails", () => {
  it.effect("is finished when GitHub applied it, and says so in the machine log", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("triage", [USER])],
        claims: [ghFailure()],
      });
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, { kind: "claimed", run: run7 });
      assert.deepStrictEqual(calls, [
        "issue 7",
        "approval 7 tomkaczocha",
        "claim 7 rawphp ready->triage",
        "issue 7",
      ]);
      assert.deepStrictEqual(
        scanMachineLog(dataDir).map((e) => [e.event, e.data]),
        [["claim_repaired", { repo: REPO, issue: 7, outcome: "finished" }]],
      );
      assert.deepStrictEqual(stepsOf(dataDir), ["step_changed", "claimed", "state_changed"]);
    }),
  );

  it.effect("adds the missing assignee when only the labels moved", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("triage", [])],
        claims: [ghFailure()],
      });
      assert.deepStrictEqual(yield* startIn(dataDir, tracker), { kind: "claimed", run: run7 });
      assert.deepStrictEqual(calls.slice(3), ["issue 7", "assign 7 rawphp"]);
    }),
  );

  it.effect("is the error when nothing was applied, with nothing written", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("ready", [])],
        claims: [ghFailure()],
      });
      const error = yield* Effect.flip(startIn(dataDir, tracker));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(calls.slice(3), ["issue 7"]);
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, run7)), false);
      assert.deepStrictEqual(scanMachineLog(dataDir), []);
    }),
  );

  it.effect("releases the issue to proposed with a comment when it cannot be finished", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("triage", [])],
        claims: [ghFailure()],
        assignFails: true,
      });
      const error = yield* Effect.flip(startIn(dataDir, tracker));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(calls.slice(3), [
        "issue 7",
        "assign 7 rawphp",
        "unassign 7 rawphp",
        "setState 7 proposed",
        `comment 7 ${CUT_SHORT_COMMENT}`,
      ]);
      assert.deepStrictEqual(
        scanMachineLog(dataDir).map((e) => [e.event, e.data]),
        [["claim_repaired", { repo: REPO, issue: 7, outcome: "released" }]],
      );
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, run7)), false);
    }),
  );

  it.effect("sets the label when the issue is ours but still labelled ready", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("ready", [USER])],
        claims: [ghFailure()],
      });
      assert.deepStrictEqual(yield* startIn(dataDir, tracker), { kind: "claimed", run: run7 });
      assert.deepStrictEqual(calls.slice(3), ["issue 7", "setState 7 triage"]);
      assert.deepStrictEqual(
        scanMachineLog(dataDir).map((e) => [e.event, e.data]),
        [["claim_repaired", { repo: REPO, issue: 7, outcome: "finished" }]],
      );
    }),
  );

  it.effect("assigns and labels when both factory labels are gone and nobody is assigned", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail(null, [])],
        claims: [ghFailure()],
      });
      assert.deepStrictEqual(yield* startIn(dataDir, tracker), { kind: "claimed", run: run7 });
      assert.deepStrictEqual(calls.slice(3), ["issue 7", "assign 7 rawphp", "setState 7 triage"]);
      assert.deepStrictEqual(
        scanMachineLog(dataDir).map((e) => [e.event, e.data]),
        [["claim_repaired", { repo: REPO, issue: 7, outcome: "finished" }]],
      );
    }),
  );

  it.effect("is the error, with nothing written, when someone else is assigned", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("triage", ["eve"])],
        claims: [ghFailure()],
      });
      const error = yield* Effect.flip(startIn(dataDir, tracker));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(calls.slice(3), ["issue 7"]);
      assert.deepStrictEqual(scanMachineLog(dataDir), []);
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, run7)), false);
    }),
  );

  it.effect("is the error, untouched, when the issue cannot be read again", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({
        issues: [detail("ready"), ghFailure()],
        claims: [new GitHubFailed({ args: ["x"], status: 2, stderr: "first" })],
      });
      const error = yield* Effect.flip(startIn(dataDir, tracker));
      assert.ok(error._tag === "GitHubFailed" && error.stderr === "first");
    }),
  );
});

describe("start: an issue in triage that is ours", () => {
  it.effect("with no run goes stuck: the factory cannot confirm what it was approved on", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({ issues: [detail("triage", [USER])] });
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: CANNOT_CONFIRM });
      assert.deepStrictEqual(calls, [
        "issue 7",
        `comment 7 ${stuckComment(CANNOT_CONFIRM)}`,
        "setState 7 stuck",
        "unassign 7 rawphp",
        `status 7 rawphp ${statusBody("stuck", "mac-mini", null, null)}`,
      ]);
      const code = { step: "start", reason: "approval-unconfirmed" };
      assert.deepStrictEqual(entriesOf(dataDir), [
        {
          event: "claimed",
          data: { machine: "mac-mini", github_user: "rawphp" },
          cause: { step: "start", reason: "claimed" },
        },
        {
          event: "state_changed",
          data: { from: "ready", to: "triage" },
          cause: { step: "start", reason: "claimed" },
        },
        { event: "stuck", data: { reason: CANNOT_CONFIRM }, cause: code },
        { event: "state_changed", data: { from: "triage", to: "stuck" }, cause: code },
        {
          event: "finished",
          data: {
            outcome: "stuck",
            total_ms: 0,
            gate_attempts: 0,
            review_cycles: null,
            pr_url: null,
            pr_end: null,
          },
          cause: code,
        },
      ]);
    }),
  );

  it.effect(
    "the new attempt comes after a finished older run, and the older run is left alone",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        olderRun(dataDir, 1, "stuck", true);
        const { tracker } = fakeTracker({ issues: [detail("triage", [USER])] });
        const outcome = yield* startIn(dataDir, tracker);
        assert.deepStrictEqual(outcome, {
          kind: "stuck",
          run: { ...run7, attempt: 2 },
          reason: CANNOT_CONFIRM,
        });
        assert.deepStrictEqual(stepsOf(dataDir), ["claimed", "state_changed", "finished"]);
      }),
  );

  it.effect("with an unfinished run that was approved is left to that run", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      olderRun(dataDir, 1, "triage", false, true);
      const { tracker, calls } = fakeTracker({ issues: [detail("triage", [USER])] });
      const outcome = yield* startIn(dataDir, tracker);
      assert.strictEqual(outcome.kind, "skipped");
      assert.deepStrictEqual(calls, ["issue 7"]);
      assert.deepStrictEqual(stepsOf(dataDir), ["step_changed", "claimed", "state_changed"]);
    }),
  );

  it.effect("with an unfinished run that records no approval, goes stuck in that run", () =>
    Effect.gen(function* () {
      // An earlier stuck path posted the comment, then failed on the label.
      const dataDir = tempDir();
      olderRun(dataDir, 1, "triage");
      const ledger = Ledger.open(dataDir, run7, { clock: () => T0 });
      handles.push(ledger);
      const code = makeCause("start", "approval-unconfirmed");
      ledger.append({ event: "stuck", data: { reason: CANNOT_CONFIRM } }, code);
      const { tracker, calls } = fakeTracker({ issues: [detail("triage", [USER])] });
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: CANNOT_CONFIRM });
      // The comment is on the issue already, so only the label, release and status follow.
      assert.deepStrictEqual(calls, [
        "issue 7",
        "setState 7 stuck",
        "unassign 7 rawphp",
        `status 7 rawphp ${statusBody("stuck", "mac-mini", null, null)}`,
      ]);
      assert.deepStrictEqual(stepsOf(dataDir), [
        "claimed",
        "state_changed",
        "stuck",
        "state_changed",
        "finished",
      ]);
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, { ...run7, attempt: 2 })), false);
    }),
  );

  it.effect("with an unfinished run in stuck, finishes it and goes stuck in a new attempt", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      olderRun(dataDir, 1, "stuck");
      const { tracker } = fakeTracker({ issues: [detail("triage", [USER])] });
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, {
        kind: "stuck",
        run: { ...run7, attempt: 2 },
        reason: CANNOT_CONFIRM,
      });
      const last = readRun(dataDir, run7).entries.at(-1)!;
      assert.strictEqual(last.event, "finished");
      assert.deepStrictEqual(last.cause, { step: "start", reason: "new-attempt-started" });
      assert.strictEqual(
        readRun(dataDir, { ...run7, attempt: 2 }).entries.at(-1)!.event,
        "finished",
      );
    }),
  );
});

describe("start: older runs of the issue", () => {
  it.effect("a new attempt finishes every unfinished older run by its last state first", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const a = olderRun(dataDir, 1, "needs-info");
      const b = olderRun(dataDir, 2, "pr-open");
      const c = olderRun(dataDir, 3, "building");
      olderRun(dataDir, 4, "stuck", true);
      const { tracker } = fakeTracker({});
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, { kind: "claimed", run: { ...run7, attempt: 5 } });
      for (const [id, expected] of [
        [a, "needs-info"],
        [b, "pr-open"],
        [c, "stuck"],
      ] as const) {
        const last = readRun(dataDir, id).entries.at(-1)!;
        assert.strictEqual(last.event, "finished");
        assert.strictEqual((last.data as { outcome: string }).outcome, expected);
        assert.deepStrictEqual(last.cause, {
          step: "start",
          reason: "new-attempt-started",
          actor: "tomkaczocha",
          label: "factory:ready",
        });
      }
    }),
  );

  it.effect("an older run whose gate is running stops the start before anything is written", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const older = olderRun(dataDir, 1, "building");
      const lock = gateLockFile(dataDir, older);
      NodeFS.mkdirSync(NodePath.dirname(lock), { recursive: true });
      NodeFS.writeFileSync(lock, "");
      const { tracker, calls } = fakeTracker({});
      const error = yield* Effect.flip(startIn(dataDir, tracker));
      assert.ok(isGateRunning(error));
      assert.deepStrictEqual(error.run, older);
      assert.deepStrictEqual(calls, ["issue 7", "approval 7 tomkaczocha"]);
      assert.strictEqual(readRun(dataDir, older).entries.at(-1)!.event, "state_changed");
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, { ...run7, attempt: 2 })), false);
    }),
  );
});

// @effect-diagnostics nodeBuiltinImport:off - the tests read real run files and lay out gate locks.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe } from "vite-plus/test";

import { timeLimitOnlyProjectConfig, type ProjectConfig } from "../config.ts";
import type { Approval, TextCheck } from "../domain/approval.ts";
import { unapprovedComment } from "../domain/approval.ts";
import type { State } from "../domain/lifecycle.ts";
import { gateLockFile } from "../gate.ts";
import { makeCause, type Cause, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { scanMachineLog } from "../ledger/machineLog.ts";
import { readRun } from "../ledger/read.ts";
import { parseRunId, runPath, type RunId } from "../ledger/runId.ts";
import { T0, useTempDirs } from "../ledger/testSupport.ts";
import {
  SessionsError,
  ThreadNotFoundError,
  type LaunchRequest,
  type Launched,
  type Model,
  type Thread,
} from "../t3/sessions.ts";
import {
  GitHubFailed,
  type ClaimOutcome,
  type FactoryComment,
  type GitHubError,
  type IssueDetail,
} from "../tracker/github.ts";
import {
  CANNOT_CONFIRM,
  CUT_SHORT_COMMENT,
  LAUNCH_FAILED,
  TEXT_CHANGED,
  launchMessage,
  sessionMayExistNote,
  statusBody,
  stuckComment,
} from "./messages.ts";
import {
  GateRunningError,
  resume,
  start,
  type Sessions,
  type StartContext,
  type StartOutcome,
  type Tracker,
} from "./start.ts";

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
  unassignFails?: boolean;
  newestComment?: FactoryComment | null;
  textChecks?: Array<TextCheck | GitHubError>;
}) => {
  const calls: Array<string> = [];
  const issues = [...(script.issues ?? [detail("ready")])];
  const claims = [...(script.claims ?? [{ kind: "claimed" } as const])];
  const textChecks = [...(script.textChecks ?? [])];
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
      return script.unassignFails ? Effect.fail(ghFailure()) : Effect.void;
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
    textCheck: (n, since, instructors) => {
      calls.push(`textCheck ${n} ${since} ${instructors.join(",")}`);
      return answer<TextCheck>(textChecks, "unchanged");
    },
  };
  return { tracker, calls };
};

const isSessionsError = Schema.is(SessionsError);
const isThreadNotFound = Schema.is(ThreadNotFoundError);

const MODEL: Model = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const LAUNCH_ID = "softfac:rawphp__softfac__7__1:launch";
const WORKTREE = "/t3/wt";

/**
 * Scripted answers for the T3 sessions the claim calls. Each method pops its next answer, or
 * repeats the last one. `launch` fails the test when the run's ledger does not yet hold the
 * `launch-sending` step: the step is written before the call, as softfac's own hook checks.
 */
const fakeSessions = (
  dataDir: string,
  script: {
    project?: string | null | SessionsError;
    launches?: Array<Launched | SessionsError>;
    archive?: Array<undefined | SessionsError>;
    thread?: Thread | ThreadNotFoundError;
    removeWorktree?: SessionsError;
  },
) => {
  const calls: Array<string> = [];
  const launchRequests: Array<LaunchRequest> = [];
  const launches = [...(script.launches ?? [])];
  const archives = [...(script.archive ?? [])];
  const popped = <A>(queue: Array<A>): A | undefined =>
    queue.length > 1 ? queue.shift() : queue[0];
  const result = <A>(answer: A | SessionsError | undefined, fallback: A) =>
    isSessionsError(answer)
      ? Effect.fail(answer)
      : Effect.succeed(answer === undefined ? fallback : answer);
  const sessions: Sessions = {
    findProject: (root) => {
      calls.push(`findProject ${root}`);
      return result(script.project === undefined ? "proj-1" : script.project, "proj-1");
    },
    launch: (request) => {
      calls.push(`launch ${request.commandId}`);
      launchRequests.push(request);
      const ledgerFile = runPath(
        dataDir,
        parseRunId(request.commandId.slice("softfac:".length, -":launch".length)),
      );
      if (!NodeFS.readFileSync(ledgerFile, "utf8").includes('"step":"launch-sending"')) {
        return Effect.die(new Error("launch was called before the launch-sending step"));
      }
      return result(popped(launches), {
        threadId: "thread-1",
        worktreePath: WORKTREE,
        branch: "t3code/abc",
      });
    },
    thread: (threadId) => {
      calls.push(`thread ${threadId}`);
      return isThreadNotFound(script.thread)
        ? Effect.fail(script.thread)
        : Effect.succeed(
            script.thread ?? { worktreePath: WORKTREE, branch: "t3code/abc", archived: false },
          );
    },
    archive: (threadId) => {
      calls.push(`archive ${threadId}`);
      const answer = popped(archives);
      return isSessionsError(answer) ? Effect.fail(answer) : Effect.void;
    },
    removeWorktree: (path) => {
      calls.push(`removeWorktree ${path}`);
      return script.removeWorktree === undefined ? Effect.void : Effect.fail(script.removeWorktree);
    },
  };
  return { sessions, calls, launchRequests };
};

const run7: RunId = { repo: REPO, issue: "7", attempt: 1 };

const isGateRunning = Schema.is(GateRunningError);

const ctxFor = (
  dataDir: string,
  tracker: Tracker,
  sessions: Sessions,
  extra: Partial<StartContext> = {},
): StartContext => ({
  repo: REPO,
  trackerUser: USER,
  machine: "mac-mini",
  project: project(),
  dataDir,
  tracker,
  repoPath: "/work/softfac",
  ghConfigDir: "/gh/rawphp",
  model: MODEL,
  sessions,
  clock: () => T0,
  ...extra,
});

const startIn = (
  dataDir: string,
  tracker: Tracker,
  sessions: Sessions = fakeSessions(dataDir, {}).sessions,
  extra: Partial<StartContext> = {},
) => start(ctxFor(dataDir, tracker, sessions, extra), 7);

const cause = (reason: string): Cause => makeCause("start", reason);
const BUILDING = statusBody("building", "mac-mini", "thread-1", null);
const FINISHED = {
  outcome: "stuck",
  total_ms: 0,
  gate_attempts: 0,
  review_cycles: null,
  pr_url: null,
  pr_end: null,
};

/** The lines of a run that was started, in order: what the ledger holds when the issue is `building`. */
const startedLines = (): Array<{ line: RunEvent; cause: Cause }> => [
  {
    line: { event: "step_changed", data: { step: `approved ${LABELED}` } },
    cause: makeCause("start", "approved", { actor: "tomkaczocha" }),
  },
  {
    line: { event: "claimed", data: { machine: "mac-mini", github_user: USER } },
    cause: cause("claimed"),
  },
  {
    line: { event: "state_changed", data: { from: "ready", to: "triage" } },
    cause: cause("claimed"),
  },
  {
    line: { event: "step_changed", data: { step: "launch-sending" } },
    cause: cause("launch-sending"),
  },
  {
    line: {
      event: "session_launched",
      data: {
        thread_id: "thread-1",
        worktree: WORKTREE,
        branch: "t3code/abc",
        model_instance: "claudeAgent",
        model: "claude-opus-5-5",
        resumed_from: null,
      },
    },
    cause: cause("session-launched"),
  },
  {
    line: { event: "step_changed", data: { step: "approval-rechecked" } },
    cause: cause("approval-rechecked"),
  },
  {
    line: { event: "state_changed", data: { from: "triage", to: "building" } },
    cause: cause("session-started"),
  },
];

const startedEvents = () =>
  startedLines().map(({ line, cause: why }) => ({
    event: line.event,
    data: line.data,
    cause: why,
  }));

/** A run file holding the first `lines` lines of `startedLines()`, as an earlier pass left it. */
const seedRun = (dataDir: string, lines: ReadonlyArray<{ line: RunEvent; cause: Cause }>) => {
  const ledger = Ledger.create(dataDir, run7, { clock: () => T0 - 1000 });
  handles.push(ledger);
  for (const { line, cause: why } of lines) ledger.append(line, why);
};

/** The lines a run ends with when it goes stuck from `triage` on the stuck line `reason`. */
const stuckTail = (reason: string, code: string) => [
  { event: "stuck", data: { reason }, cause: cause(code) },
  { event: "state_changed", data: { from: "triage", to: "stuck" }, cause: cause(code) },
  { event: "finished", data: FINISHED, cause: cause(code) },
];

/** What a stuck run does to the issue, after the session is stopped: the public comment, the label, the release, the status. */
const stuckCalls = (publicReason: string, thread: string | null) => [
  `comment 7 ${stuckComment(publicReason)}`,
  "setState 7 stuck",
  "unassign 7 rawphp",
  `status 7 rawphp ${statusBody("stuck", "mac-mini", thread, null)}`,
];

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
  it.effect("claims, launches the session and moves the issue to building", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, {
        kind: "started",
        run: run7,
        threadId: "thread-1",
      } satisfies StartOutcome);
      assert.deepStrictEqual(calls, [
        "issue 7",
        "approval 7 tomkaczocha",
        "claim 7 rawphp ready->triage",
        `textCheck 7 ${LABELED} tomkaczocha`,
        "setState 7 building",
        `status 7 rawphp ${BUILDING}`,
      ]);
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac", `launch ${LAUNCH_ID}`]);
      assert.deepStrictEqual(t3.launchRequests, [
        {
          commandId: LAUNCH_ID,
          projectId: "proj-1",
          title: "rawphp/softfac#7 Build step",
          baseRef: "main",
          startFromOrigin: false,
          message: launchMessage(REPO, 7, USER, "/gh/rawphp"),
          model: MODEL,
        },
      ]);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
    }),
  );

  it.effect("records the model the launch call sent", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      const model = { instanceId: "codex", model: "gpt-5.5" };
      yield* startIn(dataDir, tracker, t3.sessions, { model });
      assert.deepStrictEqual(t3.launchRequests[0]!.model, model);
      assert.deepStrictEqual(entriesOf(dataDir)[4]!.data, {
        thread_id: "thread-1",
        worktree: WORKTREE,
        branch: "t3code/abc",
        model_instance: "codex",
        model: "gpt-5.5",
        resumed_from: null,
      });
    }),
  );

  it.effect("records a launch that has no worktree yet", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {
        launches: [{ threadId: "thread-1", worktreePath: null, branch: null }],
      });
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(entriesOf(dataDir)[4]!.data, {
        thread_id: "thread-1",
        worktree: null,
        branch: null,
        model_instance: "claudeAgent",
        model: "claude-opus-5-5",
        resumed_from: null,
      });
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
        const t3 = fakeSessions(dataDir, {});
        const outcome = yield* startIn(dataDir, tracker, t3.sessions);
        assert.deepStrictEqual(outcome, { kind: "skipped", reason });
        assert.deepStrictEqual(calls, ["issue 7"]);
        assert.deepStrictEqual(t3.calls, []);
        assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "runs")), false);
      }
    }),
  );

  it.effect("a claim that finds an assignee is skipped and makes no run", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({ claims: [{ kind: "skipped-assigned", assignees: ["a"] }] });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, {
        kind: "skipped",
        reason: "issue #7 is already assigned to a",
      });
      // T3 is asked before the claim; nothing is launched for a claim someone else won.
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac"]);
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
      assert.deepStrictEqual(outcome, { kind: "started", run: run7, threadId: "thread-1" });
      assert.deepStrictEqual(calls.slice(0, 4), [
        "issue 7",
        "approval 7 tomkaczocha",
        "claim 7 rawphp ready->triage",
        "issue 7",
      ]);
      assert.deepStrictEqual(
        scanMachineLog(dataDir).map((e) => [e.event, e.data]),
        [["claim_repaired", { repo: REPO, issue: 7, outcome: "finished" }]],
      );
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
    }),
  );

  it.effect("adds the missing assignee when only the labels moved", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("triage", [])],
        claims: [ghFailure()],
      });
      assert.deepStrictEqual(yield* startIn(dataDir, tracker), {
        kind: "started",
        run: run7,
        threadId: "thread-1",
      });
      assert.deepStrictEqual(calls.slice(3, 5), ["issue 7", "assign 7 rawphp"]);
    }),
  );

  it.effect("is the error when nothing was applied, with nothing written", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("ready", [])],
        claims: [ghFailure()],
      });
      const t3 = fakeSessions(dataDir, {});
      const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(calls.slice(3), ["issue 7"]);
      // Nothing was launched, and no run file exists to hold a launch.
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac"]);
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
      assert.deepStrictEqual(yield* startIn(dataDir, tracker), {
        kind: "started",
        run: run7,
        threadId: "thread-1",
      });
      assert.deepStrictEqual(calls.slice(3, 5), ["issue 7", "setState 7 triage"]);
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
      assert.deepStrictEqual(yield* startIn(dataDir, tracker), {
        kind: "started",
        run: run7,
        threadId: "thread-1",
      });
      assert.deepStrictEqual(calls.slice(3, 6), [
        "issue 7",
        "assign 7 rawphp",
        "setState 7 triage",
      ]);
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
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: CANNOT_CONFIRM });
      assert.deepStrictEqual(calls, ["issue 7", ...stuckCalls(CANNOT_CONFIRM, null)]);
      // No session was launched, so no T3 call at all.
      assert.deepStrictEqual(t3.calls, []);
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

  it.effect("with an unfinished run in another state is left to the step that owns it", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      olderRun(dataDir, 1, "building", false, true);
      const { tracker, calls } = fakeTracker({ issues: [detail("triage", [USER])] });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.strictEqual(outcome.kind, "skipped");
      assert.deepStrictEqual(calls, ["issue 7"]);
      assert.deepStrictEqual(t3.calls, []);
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
      assert.deepStrictEqual(outcome, {
        kind: "started",
        run: { ...run7, attempt: 5 },
        threadId: "thread-1",
      });
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

const NO_PROJECT = "no T3 project for this repo on this machine";
const REFUSED = "Thread launch failed during resolve-project.";
const sessionsError = (operation: "archive" | "find-project" | "launch", message: string) =>
  new SessionsError({ operation, cause: new Error(message) });

describe("start: the launch", () => {
  it.effect("a repo with no T3 project goes stuck before any launch is sent", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, { project: null });
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: NO_PROJECT });
      assert.deepStrictEqual(calls, [
        "issue 7",
        "approval 7 tomkaczocha",
        "claim 7 rawphp ready->triage",
        ...stuckCalls(LAUNCH_FAILED, null),
      ]);
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac"]);
      assert.deepStrictEqual(entriesOf(dataDir), [
        ...startedEvents().slice(0, 3),
        ...stuckTail(NO_PROJECT, "launch-failed"),
      ]);
    }),
  );

  it.effect("a T3 that cannot be reached when the project is looked up claims nothing", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, { project: sessionsError("find-project", "T3 is down") });
      const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.deepStrictEqual(calls, ["issue 7", "approval 7 tomkaczocha"]);
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, run7)), false);
    }),
  );

  it.effect("a launch T3 refuses goes stuck with the detail in the ledger only", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, { launches: [sessionsError("launch", REFUSED)] });
      const detailText = sessionMayExistNote(REFUSED, LAUNCH_ID);
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: detailText });
      // The public comment never carries T3's words.
      assert.deepStrictEqual(calls.slice(3), stuckCalls(LAUNCH_FAILED, null));
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac", `launch ${LAUNCH_ID}`]);
      assert.deepStrictEqual(entriesOf(dataDir), [
        ...startedEvents().slice(0, 4),
        ...stuckTail(detailText, "launch-failed"),
      ]);
    }),
  );

  it.effect("a second attempt gets the next number and its own command id", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      olderRun(dataDir, 1, "stuck", true);
      const { tracker } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      const second = { ...run7, attempt: 2 };
      assert.deepStrictEqual(outcome, { kind: "started", run: second, threadId: "thread-1" });
      assert.deepStrictEqual(t3.calls, [
        "findProject /work/softfac",
        "launch softfac:rawphp__softfac__7__2:launch",
      ]);
      assert.deepStrictEqual(entriesOf(dataDir, second), startedEvents());
      assert.deepStrictEqual(stepsOf(dataDir), ["claimed", "state_changed", "finished"]);
    }),
  );

  it.effect("a text that changed before the second look archives the session and goes stuck", () =>
    Effect.gen(function* () {
      for (const check of ["changed", "unjudged"] as const) {
        const dataDir = tempDir();
        const { tracker, calls } = fakeTracker({ textChecks: [check] });
        const t3 = fakeSessions(dataDir, {});
        const outcome = yield* startIn(dataDir, tracker, t3.sessions);
        assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: TEXT_CHANGED });
        assert.deepStrictEqual(calls, [
          "issue 7",
          "approval 7 tomkaczocha",
          "claim 7 rawphp ready->triage",
          `textCheck 7 ${LABELED} tomkaczocha`,
          ...stuckCalls(TEXT_CHANGED, "thread-1"),
        ]);
        assert.deepStrictEqual(t3.calls, [
          "findProject /work/softfac",
          `launch ${LAUNCH_ID}`,
          "archive thread-1",
          "thread thread-1",
          `removeWorktree ${WORKTREE}`,
        ]);
        assert.deepStrictEqual(entriesOf(dataDir), [
          ...startedEvents().slice(0, 5),
          {
            event: "worktree_removed",
            data: { path: WORKTREE },
            cause: cause("worktree-removed"),
          },
          ...stuckTail(TEXT_CHANGED, "text-changed-before-start"),
        ]);
      }
    }),
  );

  it.effect(
    "an archive that fails is an error before anything is written, and the next start retries",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const { tracker, calls } = fakeTracker({
          issues: [detail("ready"), detail("triage", [USER])],
          textChecks: ["changed", "changed"],
        });
        const t3 = fakeSessions(dataDir, {
          archive: [sessionsError("archive", "T3 is busy"), undefined],
        });
        const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
        assert.strictEqual(error._tag, "FactorySessionsError");
        assert.deepStrictEqual(entriesOf(dataDir), startedEvents().slice(0, 5));
        assert.strictEqual(calls.at(-1), `textCheck 7 ${LABELED} tomkaczocha`);
        const outcome = yield* startIn(dataDir, tracker, t3.sessions);
        assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: TEXT_CHANGED });
        assert.strictEqual(t3.calls.filter((c) => c.startsWith("launch ")).length, 1);
        assert.strictEqual(t3.calls.filter((c) => c.startsWith("archive ")).length, 2);
      }),
  );

  it.effect("the second look comes after the launch is recorded and before the label", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const first = fakeTracker({ textChecks: [ghFailure()] });
      const t3 = fakeSessions(dataDir, {});
      const error = yield* Effect.flip(startIn(dataDir, first.tracker, t3.sessions));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents().slice(0, 5));
      assert.strictEqual(first.calls.at(-1), `textCheck 7 ${LABELED} tomkaczocha`);
      // The next start finds the thread in the ledger and does not launch again.
      const second = fakeTracker({ issues: [detail("triage", [USER])] });
      const outcome = yield* startIn(dataDir, second.tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "started", run: run7, threadId: "thread-1" });
      assert.strictEqual(t3.calls.filter((c) => c.startsWith("launch ")).length, 1);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
    }),
  );

  it.effect("a label change that fails after the launch is a runner error with no rollback", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({ setStateFails: true });
      const t3 = fakeSessions(dataDir, {});
      const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents().slice(0, 6));
      assert.strictEqual(calls.length, 5);
      assert.strictEqual(
        t3.calls.some((c) => c.startsWith("archive")),
        false,
      );
    }),
  );

  it.effect("an unassign that fails in the stuck path is a runner error", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({ unassignFails: true });
      const t3 = fakeSessions(dataDir, { project: null });
      const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
      assert.strictEqual(error._tag, "GitHubFailed");
      // The comment and the label went out and are on record; the summary line is not written.
      assert.deepStrictEqual(stepsOf(dataDir), [
        "step_changed",
        "claimed",
        "state_changed",
        "stuck",
      ]);
    }),
  );
});

describe("start: a launch that an earlier pass may have sent", () => {
  it.effect("writes the launch-sending step once and sends under the same command id", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 4));
      const { tracker } = fakeTracker({ issues: [detail("triage", [USER])] });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac", `launch ${LAUNCH_ID}`]);
    }),
  );

  it.effect(
    "a launch that cannot be sent after an earlier one may have been says a session may exist",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        seedRun(dataDir, startedLines().slice(0, 4));
        const { tracker, calls } = fakeTracker({ issues: [detail("triage", [USER])] });
        const t3 = fakeSessions(dataDir, { project: null });
        const outcome = yield* startIn(dataDir, tracker, t3.sessions);
        assert.strictEqual(outcome.kind, "stuck");
        const reason = outcome.kind === "stuck" ? outcome.reason : "";
        assert.ok(reason.includes("may have started a session"), reason);
        assert.ok(reason.includes(LAUNCH_ID), reason);
        assert.strictEqual(reason, sessionMayExistNote(NO_PROJECT, LAUNCH_ID));
        assert.strictEqual(calls[1], `comment 7 ${stuckComment(LAUNCH_FAILED)}`);
      }),
  );

  it.effect("a first launch that never went out has no such note", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({});
      const t3 = fakeSessions(dataDir, { project: null });
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: NO_PROJECT });
    }),
  );
});

describe("start: a resume", () => {
  const textCheckCall = `textCheck 7 ${LABELED} tomkaczocha`;
  const triage = () => fakeTracker({ issues: [detail("triage", [USER])] });

  it.effect("with no session launches and then looks at the text once", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 3));
      const { tracker, calls } = triage();
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "started", run: run7, threadId: "thread-1" });
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac", `launch ${LAUNCH_ID}`]);
      assert.deepStrictEqual(calls, [
        "issue 7",
        textCheckCall,
        "setState 7 building",
        `status 7 rawphp ${BUILDING}`,
      ]);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
    }),
  );

  it.effect("with a session that was not looked at again does not launch again", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 5));
      const { tracker, calls } = triage();
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(calls, [
        "issue 7",
        textCheckCall,
        "setState 7 building",
        `status 7 rawphp ${BUILDING}`,
      ]);
      assert.deepStrictEqual(t3.calls, []);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
    }),
  );

  it.effect("with a second look that passed does not repeat it", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 6));
      const { tracker, calls } = triage();
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(calls, [
        "issue 7",
        "setState 7 building",
        `status 7 rawphp ${BUILDING}`,
      ]);
      assert.deepStrictEqual(t3.calls, []);
    }),
  );

  it.effect("with a session and no recorded approval archives it and goes stuck", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const lines = startedLines();
      seedRun(dataDir, [lines[1]!, lines[2]!, lines[4]!]);
      const { tracker, calls } = triage();
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: CANNOT_CONFIRM });
      assert.deepStrictEqual(calls, ["issue 7", ...stuckCalls(CANNOT_CONFIRM, "thread-1")]);
      assert.deepStrictEqual(t3.calls, [
        "archive thread-1",
        "thread thread-1",
        `removeWorktree ${WORKTREE}`,
      ]);
    }),
  );
});

describe("start: stopping a session that goes stuck", () => {
  it.effect("a worktree that cannot be removed is written down and the run still goes stuck", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({ textChecks: ["changed"] });
      const t3 = fakeSessions(dataDir, {
        removeWorktree: new SessionsError({
          operation: "remove-worktree",
          cause: new Error("disk busy"),
        }),
      });
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: TEXT_CHANGED });
      assert.deepStrictEqual(calls.slice(4), stuckCalls(TEXT_CHANGED, "thread-1"));
      assert.deepStrictEqual(entriesOf(dataDir), [
        ...startedEvents().slice(0, 5),
        {
          event: "worktree_remove_failed",
          data: { path: WORKTREE, error: "disk busy" },
          cause: cause("worktree-remove-failed"),
        },
        ...stuckTail(TEXT_CHANGED, "text-changed-before-start"),
      ]);
    }),
  );

  it.effect("a thread T3 no longer knows is stopped at the worktree the ledger records", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 5));
      const { tracker } = fakeTracker({
        issues: [detail("triage", [USER])],
        textChecks: ["changed"],
      });
      const t3 = fakeSessions(dataDir, {
        thread: new ThreadNotFoundError({ threadId: "thread-1" }),
      });
      const outcome = yield* resume(ctxFor(dataDir, tracker, t3.sessions), 7);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: TEXT_CHANGED });
      assert.deepStrictEqual(t3.calls, [
        "archive thread-1",
        "thread thread-1",
        `removeWorktree ${WORKTREE}`,
      ]);
      assert.deepStrictEqual(entriesOf(dataDir).slice(5, 6), [
        { event: "worktree_removed", data: { path: WORKTREE }, cause: cause("worktree-removed") },
      ]);
    }),
  );
});

describe("resume", () => {
  const resumeIn = (dataDir: string, tracker: Tracker, sessions?: Sessions) =>
    resume(ctxFor(dataDir, tracker, sessions ?? fakeSessions(dataDir, {}).sessions), 7);

  it.effect("goes on with a triage run of ours as start does", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 3));
      const { tracker } = fakeTracker({ issues: [detail("triage", [USER])] });
      const outcome = yield* resumeIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, { kind: "started", run: run7, threadId: "thread-1" });
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
    }),
  );

  it.effect("never claims an issue put back to ready: that is the claim step's", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 3));
      const { tracker, calls } = fakeTracker({ issues: [detail("ready")] });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* resumeIn(dataDir, tracker, t3.sessions);
      assert.strictEqual(outcome.kind, "skipped");
      assert.deepStrictEqual(calls, ["issue 7"]);
      assert.deepStrictEqual(t3.calls, []);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents().slice(0, 3));
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, { ...run7, attempt: 2 })), false);
    }),
  );

  it.effect("finishes a stuck path cut short after its label moved", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const first = fakeTracker({ unassignFails: true });
      const t3 = fakeSessions(dataDir, { project: null });
      yield* Effect.flip(startIn(dataDir, first.tracker, t3.sessions));
      // The label is `factory:stuck` and the factory is still assigned.
      const { tracker, calls } = fakeTracker({ issues: [detail("stuck", [USER])] });
      const outcome = yield* resumeIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: NO_PROJECT });
      // The comment went out the first time and is not repeated.
      assert.deepStrictEqual(calls, ["issue 7", ...stuckCalls(LAUNCH_FAILED, null).slice(1)]);
      assert.deepStrictEqual(entriesOf(dataDir), [
        ...startedEvents().slice(0, 3),
        ...stuckTail(NO_PROJECT, "launch-failed").slice(0, 1),
        ...stuckTail(NO_PROJECT, "stuck-resumed").slice(1),
      ]);
    }),
  );

  it.effect("leaves a stuck issue alone when its run is finished, or it has none", () =>
    Effect.gen(function* () {
      const none = tempDir();
      const noRun = fakeTracker({ issues: [detail("stuck", [USER])] });
      assert.strictEqual((yield* resumeIn(none, noRun.tracker)).kind, "skipped");
      assert.deepStrictEqual(noRun.calls, ["issue 7"]);
      assert.strictEqual(NodeFS.existsSync(runPath(none, run7)), false);

      const finished = tempDir();
      olderRun(finished, 1, "stuck", true);
      const done = fakeTracker({ issues: [detail("stuck", [USER])] });
      assert.strictEqual((yield* resumeIn(finished, done.tracker)).kind, "skipped");
      assert.deepStrictEqual(done.calls, ["issue 7"]);
      assert.strictEqual(NodeFS.existsSync(runPath(finished, { ...run7, attempt: 2 })), false);
    }),
  );
});

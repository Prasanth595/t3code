// @effect-diagnostics nodeBuiltinImport:off - the tests read the bytes of real run files.
/**
 * `forward` of a building run, ported from softfac's `runner/tests.rs` sections "forwarding: the
 * messages" (`messages.test.ts`), "forwarding: comments", "forwarding: a body edit", "forwarding:
 * guards and failures" and "forwarding: waiting for the run a message starts". The gate half of
 * the waiting section, which needs the gate's fakes, is in `gating.test.ts`; the tests over the
 * real `gh` client are in `tracker/github.test.ts`; the pass's lines are in `pass.test.ts`. Left
 * out, for the issue that owns them: the comment-dropped notices (`dropped` is read from the
 * tracker and not acted on) and the review feedback a waiting run forwards.
 */
import * as NodeFS from "node:fs";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import { timeLimitOnlyProjectConfig, type ProjectConfig } from "../config.ts";
import type { State } from "../domain/lifecycle.ts";
import { isLedgerError } from "../ledger/errors.ts";
import { makeCause, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readRun } from "../ledger/read.ts";
import { runPath, type RunId } from "../ledger/runId.ts";
import { T0, useTempDirs } from "../ledger/testSupport.ts";
import {
  MessageRejectedError,
  SessionsError,
  ThreadNotFoundError,
  type RunStatus,
  type ThreadStatus,
} from "../t3/sessions.ts";
import {
  GitHubFailed,
  type Activity,
  type BodyEdit,
  type Comment,
  type GitHubError,
  type IssueDetail,
} from "../tracker/github.ts";
import { advance, forward, type BuildingContext, type ForwardOutcome } from "./building.ts";
import { readProgress } from "./progress.ts";
import { applyActions, progressFrom } from "./run.ts";

const tempDir = useTempDirs();

const REPO = "rawphp/softfac";
const run10: RunId = { repo: REPO, issue: "10", attempt: 1 };
const RUN = "rawphp__softfac__10__1";
const LABELED = "2026-10-04T10:00:00Z";
const URL12 = "https://github.com/rawphp/softfac/pull/12";
const DONE_MESSAGE = `Built it.\nFACTORY-DONE: ${URL12}`;
/** `since` for a ledger whose first line is at `T0`. */
const SINCE_FIRST = "2026-10-04T10:13:16Z";
const EDITED = "2026-10-04T10:15:00Z";
const HEAD = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";

// ---- the ledger -----------------------------------------------------------------------------------

type Line = { readonly event: string; readonly data: unknown };

const step = (text: string): RunEvent => ({ event: "step_changed", data: { step: text } });
const moved = (from: State, to: State): RunEvent => ({
  event: "state_changed",
  data: { from, to },
});

/** What the ledger holds when the issue is `building`: the claim, the launch and the recheck. */
const STARTED: ReadonlyArray<RunEvent> = [
  step(`approved ${LABELED}`),
  { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
  moved("ready", "triage"),
  step("launch-sending"),
  {
    event: "session_launched",
    data: {
      thread_id: "thread-1",
      worktree: "/t3/wt",
      branch: "t3code/abc",
      model_instance: "claudeAgent",
      model: "claude-opus-5-5",
      resumed_from: null,
    },
  },
  step("approval-rechecked"),
  moved("triage", "building"),
];
const PR_OPENED: RunEvent = { event: "pr_opened", data: { pr: 12, url: URL12 } };
/** The ledger of a run whose session has reported its draft pull request. */
const BASE_EVENTS: ReadonlyArray<RunEvent> = [...STARTED, PR_OPENED];

const FINISHED_EVENT: RunEvent = {
  event: "finished",
  data: {
    outcome: "stuck",
    total_ms: 0,
    gate_attempts: 0,
    review_cycles: null,
    pr_url: null,
    pr_end: null,
  },
};
const STUCK_EVENT: RunEvent = { event: "stuck", data: { reason: "gave up" } };
const QUESTIONS_EVENT: RunEvent = { event: "questions_posted", data: { questions: "1. Which?" } };
const PASSED_ATTEMPT: ReadonlyArray<RunEvent> = [
  { event: "gate_checkout", data: { attempt: 1, dir: "", sha: HEAD, base_sha: HEAD } },
  {
    event: "gate_command",
    data: { attempt: 1, command: "cargo test", exit_code: 0, duration_ms: 5 },
  },
  step(`gate-passed ${HEAD} 1`),
];

const waitStep = (k: number) => step(`forward-wait ${k}`);
const commentForwarded = (id: number): RunEvent => ({
  event: "comment_forwarded",
  data: { comment_id: String(id) },
});
const bodyForwarded = (editedAt: string) => step(`body-edit-forwarded ${editedAt}`);

// ---- what the session is sent, written out independently of the code under test ---------------------

const sendOf = (commandId: string, text: string) => `send thread-1 ${commandId} ${text}`;
const commentSend = (id: number, author: string, text: string) =>
  sendOf(
    `softfac:${RUN}:comment:${id}`,
    `Forwarded instructor comment on rawphp/softfac#10 from ${author}. Apply it at your next step boundary.\n\n${text}`,
  );
const bodySend = (editedAt: string, editor: string, text: string) =>
  sendOf(
    `softfac:${RUN}:body:${editedAt}`,
    `The body of rawphp/softfac#10 was edited by ${editor}. Go back to your Contract step and work from the new body:\n\n${text}`,
  );
/** What `forward` asks T3 when it has something to send: the thread's status once, then the sends. */
const afterStatus = (...sends: ReadonlyArray<string>) => ["status thread-1", ...sends];

// ---- the fakes ----------------------------------------------------------------------------------------

const ghFailure = () => new GitHubFailed({ args: ["api", "graphql"], status: 1, stderr: "boom" });
const sessionsFailure = (operation: "status" | "send" = "send") =>
  new SessionsError({ operation, cause: "timeout" });
const isThreadNotFound = Schema.is(ThreadNotFoundError);
const isSessionsError = Schema.is(SessionsError);

const statusOf = (
  run: RunStatus | null,
  message: string | null,
  over: Partial<ThreadStatus> = {},
): ThreadStatus => ({
  worktreePath: "/t3/wt",
  branch: "t3code/abc",
  archived: false,
  run,
  runOrdinal: run === null ? null : 1,
  lastAssistantMessage: message,
  ...over,
});

const comment = (id: number, author: string, body: string): Comment => ({
  id: String(id),
  author,
  createdAt: "2026-10-04T10:13:16Z",
  body,
});
const edit = (editedAt: string, editor: string, body: string): BodyEdit => ({
  editedAt,
  editor,
  body,
});

const issueDetail = (closed: boolean): IssueDetail => ({
  number: 10,
  title: "Build step",
  body: "Build the runner.",
  labels: ["factory:building"],
  assignees: ["rawphp"],
  author: "tomkaczocha",
  state: "building",
  closed,
});

/** What the fakes answer. A test changes it before it calls, or between two calls. */
interface World {
  activity: Activity;
  /** The next reads of the activity fail with this. */
  activityFailure: GitHubError | null;
  status: ThreadStatus | ThreadNotFoundError | SessionsError;
  /** The status is never to be read. */
  statusForbidden: boolean;
  /** The zero-based T3 call (the status read, then each send) that fails. */
  failAt: number | null;
  closed: boolean;
  closedBy: string | null;
  /** The text of each message T3 took, by command id. */
  delivered: Map<string, string>;
}

const projectConfig = (instructors: ReadonlyArray<string>): ProjectConfig => {
  const config = timeLimitOnlyProjectConfig();
  return {
    ...config,
    instructors: [...instructors],
    base: "main",
    gate: ["cargo test"],
    limits: { ...config.limits, minutes: 90 },
  };
};

/** Seeds a run file with `events`, line `i` written at `ms(i)`. */
const seed = (
  dataDir: string,
  id: RunId,
  events: ReadonlyArray<RunEvent>,
  ms: (index: number) => number = () => T0,
) => {
  let now = T0;
  const ledger = Ledger.create(dataDir, id, { clock: () => now });
  try {
    events.forEach((event, index) => {
      now = ms(index);
      ledger.append(event, makeCause("start", "seed"));
    });
  } finally {
    ledger.close();
  }
};

interface Rig {
  readonly dataDir: string;
  readonly run: RunId;
  readonly world: World;
  /** The activity reads, as `<issue> <since> <instructors>`. */
  readonly activityCalls: Array<string>;
  /** The reads of the issue and of who closed it. */
  readonly reads: Array<string>;
  /** The calls to T3, in order. */
  readonly t3: Array<string>;
  ctx: BuildingContext;
}

const rigFor = (
  events: ReadonlyArray<RunEvent> | null = STARTED,
  options: { ms?: (index: number) => number; instructors?: ReadonlyArray<string> } = {},
): Rig => {
  const dataDir = tempDir();
  if (events !== null) seed(dataDir, run10, events, options.ms);
  const world: World = {
    activity: { comments: [], bodyEdit: null, dropped: [] },
    activityFailure: null,
    status: statusOf("running", null),
    statusForbidden: false,
    failAt: null,
    closed: false,
    closedBy: null,
    delivered: new Map(),
  };
  const activityCalls: Array<string> = [];
  const reads: Array<string> = [];
  const t3: Array<string> = [];
  const notForward = () => Effect.die("not forward's");
  const tracker: BuildingContext["tracker"] = {
    activitySince: (issue, since, instructors) => {
      activityCalls.push(`${issue} ${since} ${instructors.join(",")}`);
      return world.activityFailure === null
        ? Effect.succeed(world.activity)
        : Effect.fail(world.activityFailure);
    },
    issue: (n) => {
      reads.push(`issue ${n}`);
      return Effect.succeed(issueDetail(world.closed));
    },
    closedBy: (n) => {
      reads.push(`closedBy ${n}`);
      return Effect.succeed(world.closedBy);
    },
    pullRequest: (n) => {
      reads.push(`pullRequest ${n}`);
      return Effect.succeed(null);
    },
    markPrDraft: notForward,
    markPrReady: notForward,
    commentOnPr: notForward,
    assign: notForward,
    setState: notForward,
    unassign: notForward,
    postComment: notForward,
    upsertStatusComment: notForward,
    textCheck: notForward,
  };
  const call = (text: string): SessionsError | null => {
    t3.push(text);
    return world.failAt === t3.length - 1 ? sessionsFailure() : null;
  };
  const sessions: BuildingContext["sessions"] = {
    status: (threadId) => {
      if (world.statusForbidden) return Effect.die("the status was read with nothing to send");
      const failed = call(`status ${threadId}`);
      if (failed !== null) return Effect.fail(failed);
      const answer = world.status;
      return isThreadNotFound(answer) || isSessionsError(answer)
        ? Effect.fail(answer)
        : Effect.succeed(answer);
    },
    send: (threadId, commandId, text) => {
      const failed = call(`send ${threadId} ${commandId} ${text}`);
      if (failed !== null) return Effect.fail(failed);
      world.delivered.set(commandId, text);
      return Effect.void;
    },
    thread: (threadId) => {
      t3.push(`thread ${threadId}`);
      return Effect.succeed({ worktreePath: "/t3/wt", branch: "t3code/abc", archived: false });
    },
    archive: (threadId) => {
      t3.push(`archive ${threadId}`);
      return Effect.void;
    },
    removeWorktree: (path) => {
      t3.push(`removeWorktree ${path}`);
      return Effect.void;
    },
  };
  const ctx: BuildingContext = {
    repo: REPO,
    trackerUser: "rawphp",
    machine: "mac-mini",
    project: projectConfig(options.instructors ?? ["rawphp"]),
    dataDir,
    tracker,
    sessions,
    clock: () => T0,
  };
  return { dataDir, run: run10, world, activityCalls, reads, t3, ctx };
};

const forwardIn = (rig: Rig) => forward(rig.ctx, rig.run);
const advanceIn = (rig: Rig) => advance(rig.ctx, rig.run);

const outcome = (comments: number, bodyEdit: boolean): ForwardOutcome => ({
  comments,
  bodyEdit,
  skipped: null,
});
const skipped = (why: NonNullable<ForwardOutcome["skipped"]>): ForwardOutcome => ({
  comments: 0,
  bodyEdit: false,
  skipped: why,
});

/** What GitHub says the instructors did from now on. */
const script = (rig: Rig, comments: ReadonlyArray<Comment>, bodyEdit: BodyEdit | null = null) => {
  rig.world.activity = { comments, bodyEdit, dropped: [] };
};

const linesOf = (rig: Rig): Array<Line> =>
  readRun(rig.dataDir, rig.run).entries.map(({ event, data }) => ({ event, data }));
const bytesOf = (rig: Rig) => NodeFS.readFileSync(runPath(rig.dataDir, rig.run), "utf8");
const causesOf = (rig: Rig) =>
  readRun(rig.dataDir, rig.run).entries.map(
    (entry) => `${entry.cause?.step} ${entry.cause?.reason}`,
  );

const clearCalls = (rig: Rig) => {
  rig.activityCalls.length = 0;
  rig.reads.length = 0;
  rig.t3.length = 0;
};

const setRun = (rig: Rig, status: RunStatus, ordinal: number, message: string | null = null) => {
  rig.world.status = statusOf(status, message, { runOrdinal: ordinal });
};

/** A started run whose session's latest run is `ordinal`, in `status`. */
const rigAt = (status: RunStatus, ordinal: number, events = STARTED) => {
  const rig = rigFor(events);
  setRun(rig, status, ordinal);
  return rig;
};

const instructorActivity = (rig: Rig) => {
  script(rig, [comment(101, "rawphp", "one")], edit(EDITED, "rawphp", "new"));
};

// ---- forwarding: comments ------------------------------------------------------------------------------

describe("forward: comments", () => {
  it.effect("sends each new comment once, in order, and records it", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      script(rig, [
        comment(101, "rawphp", "Use serde here."),
        comment(102, "rawphp", "And add a test."),
      ]);
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(2, false));
      assert.deepStrictEqual(rig.activityCalls, [`10 ${SINCE_FIRST} rawphp`]);
      assert.deepStrictEqual(
        rig.t3,
        afterStatus(
          commentSend(101, "rawphp", "Use serde here."),
          commentSend(102, "rawphp", "And add a test."),
        ),
      );
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        commentForwarded(101),
        commentForwarded(102),
      ]);
      // Nothing is written on GitHub: the tracker has no write the forward may call.
    }),
  );

  it.effect("writes each line under the forward step with the reason that names it", () =>
    Effect.gen(function* () {
      const rig = rigAt("completed", 1);
      script(rig, [comment(101, "rawphp", "one")], edit(EDITED, "rawphp", "new"));
      yield* forwardIn(rig);
      assert.deepStrictEqual(causesOf(rig).slice(STARTED.length), [
        "forward forward-waiting",
        "forward comment-forwarded",
        "forward body-edit-forwarded",
      ]);
    }),
  );

  it.effect("a second forward sends nothing and writes nothing", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      script(rig, [comment(101, "rawphp", "one"), comment(102, "rawphp", "two")]);
      yield* forwardIn(rig);
      const bytes = bytesOf(rig);
      clearCalls(rig);
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(0, false));
      assert.deepStrictEqual(rig.activityCalls, [`10 ${SINCE_FIRST} rawphp`]);
      assert.deepStrictEqual(rig.t3, []);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("a comment the ledger already has is not sent again, but a new one after it is", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, commentForwarded(101)]);
      script(rig, [comment(101, "rawphp", "one"), comment(102, "rawphp", "two")]);
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(1, false));
      assert.deepStrictEqual(rig.t3, afterStatus(commentSend(102, "rawphp", "two")));
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        commentForwarded(101),
        commentForwarded(102),
      ]);
    }),
  );

  it.effect("a comment forwarded out of order is still skipped by its id", () =>
    Effect.gen(function* () {
      // The ledger knows 102 but not 101: 101 is sent, 102 is not.
      const rig = rigFor([...STARTED, commentForwarded(102)]);
      script(rig, [comment(101, "rawphp", "one"), comment(102, "rawphp", "two")]);
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(1, false));
      assert.deepStrictEqual(rig.t3, afterStatus(commentSend(101, "rawphp", "one")));
    }),
  );

  it.effect("sends a comment id that GitHub lists twice only once", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      script(rig, [comment(101, "rawphp", "one"), comment(101, "rawphp", "one")]);
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(1, false));
      assert.deepStrictEqual(rig.t3, afterStatus(commentSend(101, "rawphp", "one")));
    }),
  );

  it.effect(
    "since is the first ledger line cut to whole seconds, and the instructors are the config's",
    () =>
      Effect.gen(function* () {
        // .999 must not round up to :17, and the later lines must not move it.
        const rig = rigFor(STARTED, {
          instructors: ["tom", "Amy"],
          ms: (index) => 1_791_108_796_999 + index * 60_000,
        });
        yield* forwardIn(rig);
        assert.deepStrictEqual(rig.activityCalls, ["10 2026-10-04T10:13:16Z tom,Amy"]);
        assert.deepStrictEqual(rig.t3, []);
      }),
  );

  it.effect("since stays the run's start after comments were forwarded", () =>
    Effect.gen(function* () {
      const rig = rigFor(STARTED, { ms: (index) => T0 + index * 60_000 });
      script(rig, [comment(101, "rawphp", "one")]);
      yield* forwardIn(rig);
      yield* forwardIn(rig);
      assert.deepStrictEqual(rig.activityCalls, [
        `10 ${SINCE_FIRST} rawphp`,
        `10 ${SINCE_FIRST} rawphp`,
      ]);
    }),
  );

  it.effect("uses the config's spelling of the repo in the message", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      script(rig, [comment(101, "rawphp", "one")]);
      assert.deepStrictEqual(
        yield* forward({ ...rig.ctx, repo: "RawPHP/SoftFac" }, rig.run),
        outcome(1, false),
      );
      assert.ok(rig.t3[1]!.includes("Forwarded instructor comment on RawPHP/SoftFac#10 from"));
    }),
  );
});

// ---- forwarding: what applyActions does for the two actions -----------------------------------------------

describe("forward: the actions", () => {
  /** A run file with no lines, a `Progress` for it, and the rig's context. */
  const bare = (threadId: string | null) => {
    const rig = rigFor(null);
    const ledger = Ledger.create(rig.dataDir, rig.run, { clock: () => T0 });
    const at = progressFrom("forward", readProgress([]), "building");
    at.threadId = threadId;
    return { rig, ledger, at };
  };

  it.effect("send a forwarded comment and then record it", () =>
    Effect.gen(function* () {
      const { rig, ledger, at } = bare("thread-1");
      yield* applyActions(
        rig.ctx,
        10,
        ledger,
        at,
        [{ kind: "forward-comment", commentId: "7" }],
        makeCause("forward", "comment-forwarded"),
        { forward: { commandId: "cmd-1", text: "hello" } },
      ).pipe(Effect.ensuring(Effect.sync(() => ledger.close())));
      assert.deepStrictEqual(rig.t3, ["send thread-1 cmd-1 hello"]);
      assert.deepStrictEqual(rig.reads, []);
      assert.deepStrictEqual(linesOf(rig), [commentForwarded(7)]);
    }),
  );

  it.effect("cannot forward a comment with no thread or message", () =>
    Effect.gen(function* () {
      for (const [threadId, forwardPayload] of [
        [null, { commandId: "cmd-1", text: "hello" }],
        ["thread-1", undefined],
      ] as const) {
        const { rig, ledger, at } = bare(threadId);
        const error = yield* Effect.flip(
          applyActions(
            rig.ctx,
            10,
            ledger,
            at,
            [{ kind: "forward-comment", commentId: "7" }],
            makeCause("forward", "comment-forwarded"),
            forwardPayload === undefined ? {} : { forward: forwardPayload },
          ),
        ).pipe(Effect.ensuring(Effect.sync(() => ledger.close())));
        assert.strictEqual(error._tag, "InvalidTransition");
        assert.deepStrictEqual(rig.t3, []);
        assert.deepStrictEqual(linesOf(rig), []);
      }
    }),
  );

  it.effect("send a forwarded body edit and then record its step", () =>
    Effect.gen(function* () {
      const { rig, ledger, at } = bare("thread-1");
      yield* applyActions(
        rig.ctx,
        10,
        ledger,
        at,
        [{ kind: "forward-body-edit" }],
        makeCause("forward", "body-edit-forwarded"),
        { forward: { commandId: "cmd-2", text: "new body", step: "body-edit-forwarded x" } },
      ).pipe(Effect.ensuring(Effect.sync(() => ledger.close())));
      assert.deepStrictEqual(rig.t3, ["send thread-1 cmd-2 new body"]);
      assert.deepStrictEqual(linesOf(rig), [bodyForwarded("x")]);
    }),
  );

  it.effect("cannot forward a body edit with no thread or step", () =>
    Effect.gen(function* () {
      for (const [threadId, forwardPayload] of [
        [null, { commandId: "cmd", text: "t", step: "body-edit-forwarded x" }],
        ["thread-1", { commandId: "cmd", text: "t" }],
        ["thread-1", undefined],
      ] as const) {
        const { rig, ledger, at } = bare(threadId);
        const error = yield* Effect.flip(
          applyActions(
            rig.ctx,
            10,
            ledger,
            at,
            [{ kind: "forward-body-edit" }],
            makeCause("forward", "body-edit-forwarded"),
            forwardPayload === undefined ? {} : { forward: forwardPayload },
          ),
        ).pipe(Effect.ensuring(Effect.sync(() => ledger.close())));
        assert.strictEqual(error._tag, "InvalidTransition");
        assert.deepStrictEqual(rig.t3, []);
        assert.deepStrictEqual(linesOf(rig), []);
      }
    }),
  );
});

// ---- forwarding: a body edit ------------------------------------------------------------------------------

describe("forward: a body edit", () => {
  it.effect("is sent once with its exact message and step", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      script(rig, [], edit(EDITED, "rawphp", "## Outcome\nthe new body"));
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(0, true));
      assert.deepStrictEqual(
        rig.t3,
        afterStatus(bodySend(EDITED, "rawphp", "## Outcome\nthe new body")),
      );
      assert.deepStrictEqual(linesOf(rig), [...STARTED, bodyForwarded(EDITED)]);
      assert.deepStrictEqual(rig.activityCalls, [`10 ${SINCE_FIRST} rawphp`]);
    }),
  );

  it.effect("the same edit again sends nothing, and a later edit is sent again", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      script(rig, [], edit(EDITED, "rawphp", "v1"));
      yield* forwardIn(rig);
      const bytes = bytesOf(rig);
      clearCalls(rig);

      assert.deepStrictEqual(yield* forwardIn(rig), outcome(0, false));
      assert.deepStrictEqual(rig.t3, []);
      assert.strictEqual(bytesOf(rig), bytes);

      const later = "2026-10-04T10:20:00Z";
      script(rig, [], edit(later, "rawphp", "v2"));
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(0, true));
      assert.deepStrictEqual(rig.t3, afterStatus(bodySend(later, "rawphp", "v2")));
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        bodyForwarded(EDITED),
        bodyForwarded(later),
      ]);
    }),
  );

  it.effect("goes in after the comments of its call", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      script(
        rig,
        [comment(101, "rawphp", "one"), comment(102, "rawphp", "two")],
        edit(EDITED, "rawphp", "new"),
      );
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(2, true));
      assert.deepStrictEqual(
        rig.t3,
        afterStatus(
          commentSend(101, "rawphp", "one"),
          commentSend(102, "rawphp", "two"),
          bodySend(EDITED, "rawphp", "new"),
        ),
      );
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        commentForwarded(101),
        commentForwarded(102),
        bodyForwarded(EDITED),
      ]);
    }),
  );

  it.effect("with a time that is not GitHub's form is refused before anything is sent", () =>
    Effect.gen(function* () {
      for (const bad of [
        "",
        "x",
        "2026-10-04 10:15:00",
        "2026-10-04T10:15:00.123Z",
        "2026-10-04T10:15:00+00:00",
        "2026-10-04T10:15:00Z\n",
        "2026-10-04T10:15:00Z:evil",
        "2026-10-04T10:15:0\u0000Z",
      ]) {
        const rig = rigFor();
        script(rig, [comment(101, "rawphp", "one")], edit(bad, "rawphp", "new"));
        const bytes = bytesOf(rig);
        const error = yield* Effect.flip(forwardIn(rig));
        assert.strictEqual(error._tag, "GitHubParse", JSON.stringify(bad));
        assert.include(error.message, "YYYY-MM-DDTHH:MM:SSZ", JSON.stringify(bad));
        assert.deepStrictEqual(rig.t3, [], JSON.stringify(bad));
        assert.strictEqual(bytesOf(rig), bytes, JSON.stringify(bad));
      }
    }),
  );

  it.effect("is not sent twice for a step that only looks like a forwarded edit", () =>
    Effect.gen(function* () {
      const rig = rigFor([
        ...STARTED,
        bodyForwarded("2026-10-04T10:15:00"),
        bodyForwarded("2026-10-04T10:15:00Z "),
        step(`body-edit-forwarded${EDITED}`),
      ]);
      script(rig, [], edit(EDITED, "rawphp", "new"));
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(0, true));
    }),
  );
});

// ---- forwarding: guards and failures --------------------------------------------------------------------------

/** A rig whose ledger holds `events` and whose GitHub would hand back a comment and a body edit, so a missing guard would send them. */
const guarded = (events: ReadonlyArray<RunEvent>) => {
  const rig = rigFor(events);
  instructorActivity(rig);
  return rig;
};

/** `forward` skips the run for `why`: no read of the activity or of T3, and no write. */
const assertSkips = (
  events: ReadonlyArray<RunEvent>,
  why: NonNullable<ForwardOutcome["skipped"]>,
) =>
  Effect.gen(function* () {
    const rig = guarded(events);
    const bytes = bytesOf(rig);
    assert.deepStrictEqual(yield* forwardIn(rig), skipped(why), why);
    assert.deepStrictEqual(rig.activityCalls, [], why);
    assert.deepStrictEqual(rig.t3, [], why);
    assert.strictEqual(bytesOf(rig), bytes, why);
    return rig;
  });

describe("forward: guards and failures", () => {
  it.effect("skips a finished run", () => assertSkips([...STARTED, FINISHED_EVENT], "finished"));

  it.effect("skips a run with no session", () =>
    assertSkips(
      [
        { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
        moved("ready", "triage"),
        moved("triage", "building"),
      ],
      "no-session",
    ),
  );

  it.effect("skips every state but building", () =>
    Effect.gen(function* () {
      const launched = STARTED.find((event) => event.event === "session_launched")!;
      yield* assertSkips(
        [
          { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
          moved("ready", "triage"),
          launched,
        ],
        "not-building",
      );
      yield* assertSkips(
        [...STARTED, QUESTIONS_EVENT, moved("building", "needs-info")],
        "not-building",
      );
      yield* assertSkips([...STARTED, STUCK_EVENT, moved("building", "stuck")], "not-building");
      yield* assertSkips(
        [
          ...BASE_EVENTS,
          ...PASSED_ATTEMPT,
          step("gate-results-posted"),
          moved("building", "pr-open"),
        ],
        "not-building",
      );
    }),
  );

  it.effect("skips a run whose gate pass is recorded", () =>
    assertSkips([...BASE_EVENTS, ...PASSED_ATTEMPT], "not-building"),
  );

  it.effect("skips a run an operator asked to stop", () =>
    assertSkips(
      [...STARTED, { event: "stop_requested", data: { by: "operator" } }],
      "not-building",
    ),
  );

  it.effect("skips a transition to stuck or needs-info that was cut short", () =>
    Effect.gen(function* () {
      // The decision is in the ledger but `state_changed`, the commit marker, is not.
      yield* assertSkips([...STARTED, STUCK_EVENT], "not-building");
      yield* assertSkips([...STARTED, QUESTIONS_EVENT], "not-building");
    }),
  );

  it.effect("skips a run whose gate send is pending", () =>
    Effect.gen(function* () {
      // A gate attempt was being sent into the session and the ledger does not say it arrived:
      // a message sent now could be mistaken for the proof that it did.
      yield* assertSkips([...BASE_EVENTS, step("gate-sending 1 1")], "gate-send-pending");
      // Once `gate_sent_back` is written the run is forwarded to again.
      const rig = guarded([
        ...BASE_EVENTS,
        step("gate-sending 1 1"),
        { event: "gate_sent_back", data: { attempt: 1, run_ordinal: 1 } },
      ]);
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(1, true));
    }),
  );

  it.effect("refuses a run of another repo before touching anything", () =>
    Effect.gen(function* () {
      const rig = guarded(STARTED);
      const other: RunId = { repo: "rawphp/other", issue: "10", attempt: 1 };
      const error = yield* Effect.flip(forward(rig.ctx, other));
      assert.strictEqual(error._tag, "WrongRepoError");
      assert.deepStrictEqual(rig.activityCalls, []);
      assert.deepStrictEqual(rig.reads, []);
      assert.deepStrictEqual(rig.t3, []);
    }),
  );

  it.effect("compares the repo case-insensitively", () =>
    Effect.gen(function* () {
      const rig = guarded(STARTED);
      assert.deepStrictEqual(
        yield* forward({ ...rig.ctx, repo: "RawPHP/SoftFac" }, rig.run),
        outcome(1, true),
      );
    }),
  );

  it.effect("on a run with no file is a ledger error", () =>
    Effect.gen(function* () {
      const rig = rigFor(null);
      const error = yield* Effect.flip(forwardIn(rig));
      assert.ok(isLedgerError(error), error.message);
      assert.deepStrictEqual(rig.activityCalls, []);
      assert.deepStrictEqual(rig.t3, []);
    }),
  );

  it.effect("a failing activity read is an error with nothing sent or written", () =>
    Effect.gen(function* () {
      const rig = guarded(STARTED);
      const bytes = bytesOf(rig);
      rig.world.activityFailure = ghFailure();
      const error = yield* Effect.flip(forwardIn(rig));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(rig.t3, []);
      assert.strictEqual(bytesOf(rig), bytes);

      // The next call, with GitHub back, does the work.
      rig.world.activityFailure = null;
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(1, true));
    }),
  );

  it.effect("a failed send stops the call, and the rest is sent in order under the same ids", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      script(rig, [
        comment(101, "rawphp", "one"),
        comment(102, "rawphp", "two"),
        comment(103, "rawphp", "three"),
      ]);
      // The status read is call 0; the second send, call 2, times out.
      rig.world.failAt = 2;
      const error = yield* Effect.flip(forwardIn(rig));
      assert.strictEqual(error._tag, "FactorySessionsError");
      // The first is recorded; the second and the third are not, and the third was not tried.
      assert.deepStrictEqual(linesOf(rig), [...STARTED, commentForwarded(101)]);
      assert.deepStrictEqual(
        rig.t3,
        afterStatus(commentSend(101, "rawphp", "one"), commentSend(102, "rawphp", "two")),
      );

      rig.world.failAt = null;
      clearCalls(rig);
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(2, false));
      assert.deepStrictEqual(
        rig.t3,
        afterStatus(commentSend(102, "rawphp", "two"), commentSend(103, "rawphp", "three")),
      );
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        commentForwarded(101),
        commentForwarded(102),
        commentForwarded(103),
      ]);
    }),
  );

  it.effect("a send T3 refuses fails the call and records nothing for it", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      script(rig, [comment(101, "rawphp", "one")]);
      const refused = new MessageRejectedError({
        threadId: "thread-1",
        commandId: `softfac:${RUN}:comment:101`,
        cause: "no",
      });
      rig.ctx = {
        ...rig.ctx,
        sessions: { ...rig.ctx.sessions, send: () => Effect.fail(refused) },
      };
      const error = yield* Effect.flip(forwardIn(rig));
      assert.strictEqual(error._tag, "FactoryMessageRejectedError");
      assert.deepStrictEqual(linesOf(rig), [...STARTED]);
    }),
  );

  it.effect("a failed edit send leaves the comments recorded and the edit for the next call", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      instructorActivity(rig);
      // Status is call 0, the comment's send call 1, the edit's send call 2.
      rig.world.failAt = 2;
      yield* Effect.flip(forwardIn(rig));
      assert.deepStrictEqual(linesOf(rig), [...STARTED, commentForwarded(101)]);

      rig.world.failAt = null;
      clearCalls(rig);
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(0, true));
      assert.deepStrictEqual(rig.t3, afterStatus(bodySend(EDITED, "rawphp", "new")));
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        commentForwarded(101),
        bodyForwarded(EDITED),
      ]);
    }),
  );
});

describe("forward: a closed issue", () => {
  it.effect("closed by a person abandons the run and sends nothing", () =>
    Effect.gen(function* () {
      const rig = guarded(STARTED);
      rig.world.closed = true;
      rig.world.closedBy = "alice";
      assert.deepStrictEqual(yield* forwardIn(rig), skipped("abandoned"));
      assert.deepStrictEqual(rig.activityCalls, []);
      assert.deepStrictEqual(rig.t3, [
        "archive thread-1",
        "thread thread-1",
        "removeWorktree /t3/wt",
      ]);
      const lines = linesOf(rig);
      assert.deepStrictEqual(
        lines.slice(STARTED.length).map((l) => l.event),
        ["worktree_removed", "finished"],
      );
      assert.deepStrictEqual(causesOf(rig).at(-1), "forward issue-closed");
    }),
  );

  it.effect("closed by the run's own merged pull request sends nothing and writes nothing", () =>
    Effect.gen(function* () {
      const rig = guarded(BASE_EVENTS);
      rig.world.closed = true;
      rig.ctx = {
        ...rig.ctx,
        tracker: {
          ...rig.ctx.tracker,
          pullRequest: () =>
            Effect.succeed({
              number: 12,
              isDraft: false,
              open: false,
              merged: true,
              headRef: "t3code/abc",
              crossRepository: false,
              baseRef: "main",
              headSha: HEAD,
            }),
        },
      };
      const bytes = bytesOf(rig);
      assert.deepStrictEqual(yield* forwardIn(rig), skipped("pr-merged"));
      assert.deepStrictEqual(rig.activityCalls, []);
      assert.deepStrictEqual(rig.t3, []);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );
});

// ---- forwarding: waiting for the run a message starts -------------------------------------------------------------

describe("forward: waiting for the run a message starts", () => {
  it.effect(
    "an idle session gets a wait marker before the send, and advance waits for a newer run",
    () =>
      Effect.gen(function* () {
        // The first run ended with FACTORY-DONE and `advance` recorded the draft pull request.
        const rig = rigFor(BASE_EVENTS);
        setRun(rig, "completed", 1, DONE_MESSAGE);
        script(rig, [comment(101, "rawphp", "also do this")]);
        assert.deepStrictEqual(yield* forwardIn(rig), outcome(1, false));
        // The status is read once, then the message goes in.
        assert.deepStrictEqual(rig.t3, afterStatus(commentSend(101, "rawphp", "also do this")));
        assert.deepStrictEqual(linesOf(rig), [...BASE_EVENTS, waitStep(1), commentForwarded(101)]);

        // The status still shows run 1, the one that ended, as the latest: the message has not
        // started its run yet, so nothing is decided and nothing is written.
        clearCalls(rig);
        const bytes = bytesOf(rig);
        assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
        assert.strictEqual(bytesOf(rig), bytes);

        // The new run is active, then it ends with FACTORY-DONE: the flow goes on.
        setRun(rig, "running", 2, DONE_MESSAGE);
        assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
        setRun(rig, "completed", 2, DONE_MESSAGE);
        rig.ctx = {
          ...rig.ctx,
          tracker: { ...rig.ctx.tracker, pullRequest: () => Effect.succeed(draftPr) },
        };
        assert.deepStrictEqual(yield* advanceIn(rig), {
          kind: "ready-for-gate",
          pr: 12,
          prUrl: URL12,
        });
      }),
  );

  it.effect("the marker is written before the send", () =>
    Effect.gen(function* () {
      const rig = rigAt("completed", 1);
      script(rig, [comment(101, "rawphp", "one")]);
      // The status is call 0, the send call 1.
      rig.world.failAt = 1;
      yield* Effect.flip(forwardIn(rig));
      assert.deepStrictEqual(linesOf(rig), [...STARTED, waitStep(1)]);
    }),
  );

  it.effect("an active session gets no marker because T3 steers the message into it", () =>
    Effect.gen(function* () {
      for (const status of ["running", "queued", "waiting", "preparing", "starting"] as const) {
        const rig = rigAt(status, 1);
        script(rig, [comment(101, "rawphp", "one")]);
        assert.deepStrictEqual(yield* forwardIn(rig), outcome(1, false), status);
        assert.deepStrictEqual(rig.t3, afterStatus(commentSend(101, "rawphp", "one")), status);
        assert.deepStrictEqual(linesOf(rig), [...STARTED, commentForwarded(101)], status);
      }
    }),
  );

  it.effect("every ended status gets a marker", () =>
    Effect.gen(function* () {
      for (const status of [
        "completed",
        "interrupted",
        "failed",
        "cancelled",
        "rolled_back",
      ] as const) {
        const rig = rigAt(status, 4);
        script(rig, [comment(101, "rawphp", "one")]);
        yield* forwardIn(rig);
        assert.deepStrictEqual(
          linesOf(rig),
          [...STARTED, waitStep(4), commentForwarded(101)],
          status,
        );
      }
    }),
  );

  it.effect("a thread with no run, or no ordinal, waits after ordinal zero", () =>
    Effect.gen(function* () {
      const none = rigFor();
      none.world.status = statusOf(null, null);
      script(none, [comment(101, "rawphp", "one")]);
      yield* forwardIn(none);
      const want = [...STARTED, waitStep(0), commentForwarded(101)];
      assert.deepStrictEqual(linesOf(none), want);

      const noOrdinal = rigFor();
      noOrdinal.world.status = statusOf("completed", null, { runOrdinal: null });
      script(noOrdinal, [comment(101, "rawphp", "one")]);
      yield* forwardIn(noOrdinal);
      assert.deepStrictEqual(linesOf(noOrdinal), want);
    }),
  );

  it.effect("with nothing to send the status is not read", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.statusForbidden = true;
      // No activity at all.
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(0, false));
      assert.deepStrictEqual(rig.t3, []);
      // Everything is already forwarded.
      const done = rigFor([...STARTED, commentForwarded(101), bodyForwarded(EDITED)]);
      done.world.statusForbidden = true;
      script(done, [comment(101, "rawphp", "one")], edit(EDITED, "rawphp", "new"));
      assert.deepStrictEqual(yield* forwardIn(done), outcome(0, false));
      assert.deepStrictEqual(done.t3, []);
      assert.strictEqual(linesOf(done).length, STARTED.length + 2);
    }),
  );

  it.effect("a thread that no longer exists skips the call and sends nothing", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.status = new ThreadNotFoundError({ threadId: "thread-1" });
      script(rig, [comment(101, "rawphp", "one")]);
      const bytes = bytesOf(rig);
      assert.deepStrictEqual(yield* forwardIn(rig), skipped("no-thread"));
      // Only the activity was read from GitHub.
      assert.deepStrictEqual(rig.activityCalls, [`10 ${SINCE_FIRST} rawphp`]);
      assert.deepStrictEqual(rig.t3, ["status thread-1"]);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("an archived thread counts as one T3 no longer has", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.status = statusOf("completed", null, { archived: true });
      script(rig, [comment(101, "rawphp", "one")]);
      const bytes = bytesOf(rig);
      assert.deepStrictEqual(yield* forwardIn(rig), skipped("no-thread"));
      assert.deepStrictEqual(rig.t3, ["status thread-1"]);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("any other T3 error at the status read is an error with nothing sent or written", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.status = sessionsFailure("status");
      script(rig, [comment(101, "rawphp", "one")]);
      const bytes = bytesOf(rig);
      const error = yield* Effect.flip(forwardIn(rig));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.deepStrictEqual(rig.t3, ["status thread-1"]);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("two calls in a row with the same ended run write one marker", () =>
    Effect.gen(function* () {
      const rig = rigAt("completed", 1);
      script(rig, [comment(101, "rawphp", "one")]);
      yield* forwardIn(rig);
      // The thread still shows run 1 as the latest.
      script(rig, [comment(101, "rawphp", "one"), comment(102, "rawphp", "two")]);
      assert.deepStrictEqual(yield* forwardIn(rig), outcome(1, false));
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        waitStep(1),
        commentForwarded(101),
        commentForwarded(102),
      ]);
    }),
  );

  it.effect("a new ended run after the marker gets its own marker", () =>
    Effect.gen(function* () {
      const rig = rigAt("completed", 1);
      script(rig, [comment(101, "rawphp", "one")]);
      yield* forwardIn(rig);
      setRun(rig, "completed", 2);
      script(rig, [comment(101, "rawphp", "one"), comment(102, "rawphp", "two")]);
      yield* forwardIn(rig);
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        waitStep(1),
        commentForwarded(101),
        waitStep(2),
        commentForwarded(102),
      ]);
    }),
  );

  it.effect("a gate send-back at the same ordinal already is the most recent marker", () =>
    Effect.gen(function* () {
      const events = [
        ...BASE_EVENTS,
        { event: "gate_sent_back", data: { attempt: 1, run_ordinal: 1 } } satisfies RunEvent,
      ];
      const rig = rigAt("completed", 1, events);
      script(rig, [comment(101, "rawphp", "one")]);
      yield* forwardIn(rig);
      assert.deepStrictEqual(linesOf(rig), [...events, commentForwarded(101)]);
    }),
  );

  it.effect("a marker the gate dropped is still the last wait, so no second one is written", () =>
    Effect.gen(function* () {
      // The send-back's marker is dropped by the next `gate_command`, but its ordinal stays.
      const events = [
        ...BASE_EVENTS,
        { event: "gate_sent_back", data: { attempt: 1, run_ordinal: 1 } } satisfies RunEvent,
        {
          event: "gate_command",
          data: { attempt: 2, command: "cargo test", exit_code: 0, duration_ms: 5 },
        } satisfies RunEvent,
      ];
      const rig = rigAt("completed", 1, events);
      script(rig, [comment(101, "rawphp", "one")]);
      yield* forwardIn(rig);
      assert.deepStrictEqual(linesOf(rig), [...events, commentForwarded(101)]);
    }),
  );
});

const draftPr = {
  number: 12,
  isDraft: true,
  open: true,
  merged: false,
  headRef: "t3code/abc",
  crossRepository: false,
  baseRef: "main",
  headSha: HEAD,
};

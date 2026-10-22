// @effect-diagnostics nodeBuiltinImport:off - the broken-worktree tests lay out a real ledger.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { describe, vi } from "vite-plus/test";

import { timeLimitOnlyProjectConfig, type MachineConfig } from "./config.ts";
import { liveWorld } from "./index.ts";
import { makeCause } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { newRunId, runIdFileName } from "./ledger/runId.ts";
import { T0, ticking, useTempDirs } from "./ledger/testSupport.ts";
import type { Repo } from "./pass.ts";
import { FactoryProcess } from "./process.ts";
import * as Sessions from "./t3/sessions.ts";

/**
 * The base each step's context carries, as `<step> <base>`. The steps are wrapped, not run: this
 * test is about the one thing `liveWorld` does for a step of a run, which is to build its context
 * for the base the pass hands it. What a step does with `ctx.project.base` is its own tests'.
 */
const { bases, wrapped } = vi.hoisted(() => {
  const bases: Array<string> = [];
  const wrapped = <F>(name: string): F =>
    ((ctx: { readonly project: { readonly base: string } }) => {
      bases.push(`${name} ${ctx.project.base}`);
      return Effect.void;
    }) as unknown as F;
  return { bases, wrapped };
});

vi.mock("./runner/building.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner/building.ts")>();
  return {
    ...actual,
    timeLimit: wrapped<typeof actual.timeLimit>("timeLimit"),
    watch: wrapped<typeof actual.watch>("watch"),
    forward: wrapped<typeof actual.forward>("forward"),
    advance: wrapped<typeof actual.advance>("advance"),
    interrupted: wrapped<typeof actual.interrupted>("interrupted"),
  };
});

vi.mock("./runner/feedback.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner/feedback.ts")>();
  return { ...actual, feedback: wrapped<typeof actual.feedback>("feedback") };
});

const machine: MachineConfig = {
  ghConfigDir: "/gh/rawphp",
  pollSeconds: 60,
  maxConcurrentRuns: 1,
  maxConcurrentGates: 1,
  feedbackSeconds: 600,
  notify: true,
  minFreeGib: 0,
};

const repo: Repo = {
  watched: { repo: "rawphp/softfac", path: "/p" },
  project: { ...timeLimitOnlyProjectConfig(), base: "main" },
  trackerUser: "rawphp",
};

const stubSessions = Sessions.FactorySessions.of({
  findProject: () => Effect.succeed(null),
  launch: () => Effect.die("not launched"),
  status: () => Effect.die("no status"),
  thread: () => Effect.die("no thread"),
  send: () => Effect.die("not sent"),
  archive: () => Effect.die("not archived"),
  removeWorktree: () => Effect.die("not removed"),
  brokenWorktrees: Effect.succeed([]),
  runningThreads: Effect.succeed(0),
  worktreesDirectory: (defaultDir) => Effect.succeed(defaultDir),
});

describe("liveWorld: a step of a run is built for the base the pass hands it", () => {
  it.effect("each step's context has that base, or the repo's when the run recorded none", () =>
    Effect.gen(function* () {
      const world = liveWorld(
        machine,
        "/factory-test/data",
        FactoryProcess.of({ run: () => Effect.die("no gh") }),
        NodeServices.layer,
        stubSessions,
        () => 0,
        "mac-mini",
        { list: () => Effect.succeed([]), raise: () => Effect.void, clear: () => Effect.void },
        {
          gate: { run: () => Effect.die("no gate") },
          wake: Effect.void,
          scope: yield* Scope.make(),
        },
      );
      const run = newRunId("rawphp/softfac", "10", 1);
      const evidence = { t3Error: null, endedInPass: 1, t3Starts: [], t3Stops: [] };
      for (const base of ["feature/x", null]) {
        yield* world.timeLimit(repo, run, base);
        yield* world.watch(repo, run, base);
        yield* world.forward(repo, run, base);
        yield* world.advance(repo, run, base);
        yield* world.interrupted(repo, run, base, evidence);
        yield* world.feedback(repo, run, base);
      }
      assert.deepStrictEqual(bases, [
        "timeLimit feature/x",
        "watch feature/x",
        "forward feature/x",
        "advance feature/x",
        "interrupted feature/x",
        "feedback feature/x",
        "timeLimit main",
        "watch main",
        "forward main",
        "advance main",
        "interrupted main",
        "feedback main",
      ]);
    }),
  );
});

describe("liveWorld: threads on a broken worktree", () => {
  const tempDir = useTempDirs();

  const worldOver = (
    dataDir: string,
    sessions: Sessions.FactorySessions["Service"],
    clock: () => number = () => 0,
  ) =>
    Effect.gen(function* () {
      return liveWorld(
        machine,
        dataDir,
        FactoryProcess.of({ run: () => Effect.die("no gh") }),
        NodeServices.layer,
        sessions,
        clock,
        "mac-mini",
        { list: () => Effect.succeed([]), raise: () => Effect.void, clear: () => Effect.void },
        {
          gate: { run: () => Effect.die("no gate") },
          wake: Effect.void,
          scope: yield* Scope.make(),
        },
      );
    });

  /** A run whose session is `threadId`, launched before T3 had made its worktree. */
  const launched = (dataDir: string, issue: string, threadId: string, finish: boolean) => {
    const run = newRunId("rawphp/softfac", issue, 1);
    const ledger = Ledger.create(dataDir, run, { clock: ticking(T0, 1000) });
    ledger.append(
      {
        event: "session_launched",
        data: {
          thread_id: threadId,
          worktree: null,
          branch: null,
          model_instance: null,
          model: null,
          model_options: null,
          resumed_from: null,
        },
      },
      makeCause("start", "session-launched"),
    );
    if (finish) ledger.finish("stuck", null, null, makeCause("start", "stuck"));
    ledger.close();
    return run;
  };

  it.effect(
    "are the factory's only on a stopped session's worktree, grouped by worktree with its run",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const finished = launched(dataDir, "187", "session-1", true);
        const going = launched(dataDir, "188", "session-2", false);
        const world = yield* worldOver(
          dataDir,
          Sessions.FactorySessions.of({
            ...stubSessions,
            brokenWorktrees: Effect.succeed([
              // Two subagents left on the finished run's worktree, beside its archived session.
              {
                threadId: "child-1",
                worktreePath: "/wt/t3-a",
                threadsOnPath: ["child-1", "child-2", "session-1"],
              },
              {
                threadId: "child-2",
                worktreePath: "/wt/t3-a",
                threadsOnPath: ["child-1", "child-2", "session-1"],
              },
              // The session of a run still going: its own stop archives what is on its worktree.
              { threadId: "session-2", worktreePath: "/wt/t3-b", threadsOnPath: ["session-2"] },
              // A person's thread.
              { threadId: "someone", worktreePath: "/wt/t3-c", threadsOnPath: ["someone"] },
            ]),
          }),
        );
        const first = {
          worktreePath: "/wt/t3-a",
          run: finished,
          threadIds: ["child-1", "child-2"],
        };
        assert.deepStrictEqual(yield* world.brokenWorktrees(), [first]);
        assert.deepStrictEqual(yield* world.brokenWorktrees(), [first]);
        // Once the run's session is stopped, its thread is the pass's to archive.
        const ledger = Ledger.open(dataDir, going, { clock: ticking(T0 + 10_000, 1000) });
        ledger.finish("stuck", null, null, makeCause("start", "stuck"));
        ledger.close();
        assert.deepStrictEqual(yield* world.brokenWorktrees(), [
          first,
          { worktreePath: "/wt/t3-b", run: going, threadIds: ["session-2"] },
        ]);
      }),
  );

  it.effect("reads the ledger once for a thread that is not the factory's", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const world = yield* worldOver(
        dataDir,
        Sessions.FactorySessions.of({
          ...stubSessions,
          brokenWorktrees: Effect.succeed([
            { threadId: "someone", worktreePath: "/wt/t3-c", threadsOnPath: ["someone"] },
          ]),
        }),
      );
      assert.deepStrictEqual(yield* world.brokenWorktrees(), []);
      // Any read of the ledger now fails: the runs folder is a file.
      NodeFS.writeFileSync(NodePath.join(dataDir, "runs"), "not a folder");
      assert.deepStrictEqual(yield* world.brokenWorktrees(), []);
    }),
  );

  /** A sessions stub that always finds `child-1` live on the finished run's worktree. */
  const childOnBroken = Sessions.FactorySessions.of({
    ...stubSessions,
    archive: () => Effect.void,
    brokenWorktrees: Effect.succeed([
      { threadId: "child-1", worktreePath: "/wt/t3-a", threadsOnPath: ["child-1", "session-1"] },
    ]),
  });

  it.effect("fails when the ledger cannot be read, and finds the thread once it can", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const runs = NodePath.join(dataDir, "runs");
      NodeFS.writeFileSync(runs, "not a folder");
      const world = yield* worldOver(dataDir, childOnBroken);
      const error = yield* Effect.flip(world.brokenWorktrees());
      assert.strictEqual(error.kind, "ledger");
      NodeFS.rmSync(runs);
      const run = launched(dataDir, "187", "session-1", true);
      assert.deepStrictEqual(yield* world.brokenWorktrees(), [
        { worktreePath: "/wt/t3-a", run, threadIds: ["child-1"] },
      ]);
    }),
  );

  it.effect("rules no thread out while a run file cannot be read", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = launched(dataDir, "187", "session-1", true);
      const file = NodePath.join(dataDir, "runs", runIdFileName(run));
      NodeFS.chmodSync(file, 0o000);
      let now = T0;
      const world = yield* worldOver(dataDir, childOnBroken, () => now);
      assert.deepStrictEqual(yield* world.brokenWorktrees(), []);
      NodeFS.chmodSync(file, 0o644);
      now = T0 + 5 * 60 * 1000;
      assert.deepStrictEqual(yield* world.brokenWorktrees(), [
        { worktreePath: "/wt/t3-a", run, threadIds: ["child-1"] },
      ]);
    }),
  );

  it.effect("reads the ledger again for an unsettled thread only every five minutes", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = launched(dataDir, "187", "session-1", true);
      const file = NodePath.join(dataDir, "runs", runIdFileName(run));
      NodeFS.chmodSync(file, 0o000);
      let now = T0;
      const world = yield* worldOver(dataDir, childOnBroken, () => now);
      assert.deepStrictEqual(yield* world.brokenWorktrees(), []);
      // Any read of the ledger now fails: the runs folder is a file.
      NodeFS.chmodSync(file, 0o644);
      NodeFS.rmSync(NodePath.join(dataDir, "runs"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dataDir, "runs"), "not a folder");
      now = T0 + 5 * 60 * 1000 - 1;
      assert.deepStrictEqual(yield* world.brokenWorktrees(), []);
      now = T0 + 5 * 60 * 1000;
      const error = yield* Effect.flip(world.brokenWorktrees());
      assert.strictEqual(error.kind, "ledger");
    }),
  );

  it.effect("reads the ledger at once when a new thread turns up beside an unsettled one", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = launched(dataDir, "187", "session-1", true);
      launched(dataDir, "188", "session-2", false);
      const found = [
        { threadId: "session-2", worktreePath: "/wt/t3-b", threadsOnPath: ["session-2"] },
      ];
      const world = yield* worldOver(
        dataDir,
        Sessions.FactorySessions.of({
          ...stubSessions,
          brokenWorktrees: Effect.sync(() => [...found]),
        }),
      );
      assert.deepStrictEqual(yield* world.brokenWorktrees(), []);
      found.push({
        threadId: "child-1",
        worktreePath: "/wt/t3-a",
        threadsOnPath: ["child-1", "session-1"],
      });
      assert.deepStrictEqual(yield* world.brokenWorktrees(), [
        { worktreePath: "/wt/t3-a", run, threadIds: ["child-1"] },
      ]);
    }),
  );

  it.effect("reads no ledger while no thread is on a broken worktree", () =>
    Effect.gen(function* () {
      // A data dir whose runs folder is a file: any read of the ledger would fail.
      const dataDir = tempDir();
      NodeFS.writeFileSync(NodePath.join(dataDir, "runs"), "not a folder");
      const world = yield* worldOver(dataDir, stubSessions);
      assert.deepStrictEqual(yield* world.brokenWorktrees(), []);
    }),
  );
});

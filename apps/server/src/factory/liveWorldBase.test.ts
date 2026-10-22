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
import { newRunId } from "./ledger/runId.ts";
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
  unbindWorktree: () => Effect.die("not unbound"),
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

  const worldOver = (dataDir: string, sessions: Sessions.FactorySessions["Service"]) =>
    Effect.gen(function* () {
      return liveWorld(
        machine,
        dataDir,
        FactoryProcess.of({ run: () => Effect.die("no gh") }),
        NodeServices.layer,
        sessions,
        () => 0,
        "mac-mini",
        { list: () => Effect.succeed([]), raise: () => Effect.void, clear: () => Effect.void },
        {
          gate: { run: () => Effect.die("no gate") },
          wake: Effect.void,
          scope: yield* Scope.make(),
        },
      );
    });

  it.effect("are the factory's only on a worktree a run launched, each named with that run", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = newRunId("rawphp/softfac", "187", 1);
      const ledger = Ledger.create(dataDir, run, { clock: ticking(T0, 1000) });
      ledger.append(
        {
          event: "session_launched",
          data: {
            thread_id: "session-1",
            worktree: "/wt/t3-factory",
            branch: "t3/factory-issue-187",
            model_instance: null,
            model: null,
            model_options: null,
            resumed_from: null,
          },
        },
        makeCause("start", "launched"),
      );
      ledger.close();
      const world = yield* worldOver(
        dataDir,
        Sessions.FactorySessions.of({
          ...stubSessions,
          brokenWorktrees: Effect.succeed([
            { threadId: "child-1", worktreePath: "/wt/t3-factory" },
            { threadId: "someone-else", worktreePath: "/wt/t3-person" },
          ]),
        }),
      );
      assert.deepStrictEqual(yield* world.brokenWorktrees(), [
        { threadId: "child-1", worktreePath: "/wt/t3-factory", run },
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

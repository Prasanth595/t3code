import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { describe } from "vite-plus/test";

import { timeLimitOnlyProjectConfig, type MachineConfig } from "./config.ts";
import { factoryRuntime, FactoryLoop, FactoryRuntime, liveWorld, ownsThread } from "./index.ts";
import { makeCause } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { scanMachineLog } from "./ledger/machineLog.ts";
import { newRunId } from "./ledger/runId.ts";
import type { Repo } from "./pass.ts";
import { CUT_SHORT_COMMENT } from "./runner/messages.ts";
import { utcSecond } from "./runner/start.ts";
import { MARKER } from "./tracker/github.ts";
import { FactoryProcess, RunSpawnError, type RunInput, type RunResult } from "./process.ts";
import { EventsError, FactoryEvents } from "./t3/events.ts";
import * as Paths from "./t3/paths.ts";
import * as Sessions from "./t3/sessions.ts";

/** A process runner on a machine with no `gh`: every call fails to start. */
const noGh = Layer.succeed(
  FactoryProcess,
  FactoryProcess.of({
    run: () => Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") })),
  }),
);

/** A FactorySessions that finds no T3 project and dies on anything else. */
const stubSessions = Sessions.FactorySessions.of({
  findProject: () => Effect.succeed(null),
  launch: () => Effect.die("not launched"),
  status: () => Effect.die("no status"),
  thread: () => Effect.die("no thread"),
  send: () => Effect.die("not sent"),
  archive: () => Effect.die("not archived"),
  removeWorktree: () => Effect.die("not removed"),
});
const noSessions = Layer.succeed(Sessions.FactorySessions, stubSessions);

/** FactoryEvents that never says anything. */
const quietEvents = Layer.succeed(
  FactoryEvents,
  FactoryEvents.of({ runStatusChanges: Stream.never }),
);

const messageText = (message: unknown): string => {
  const first = Array.isArray(message) ? message[0] : message;
  return typeof first === "string" ? first : String(first);
};

const VALID = `gh_config_dir: /gh
max_concurrent_runs: 1
model: claude-sonnet-5-5
repos:
  - repo: a/b
    path: /b
`;

/** Builds FactoryRuntime over a temp base dir whose factory dir holds `config` (or no file) and returns the log lines. */
const logsFor = (
  config: string | undefined,
  setup: (
    factoryDir: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> = () => Effect.void,
  gh: Layer.Layer<FactoryProcess> = noGh,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-index-" });
      const factoryDir = join(baseDir, "factory");
      yield* fs.makeDirectory(factoryDir);
      const machineConfigPath = join(factoryDir, "config.yml");
      if (config !== undefined) yield* fs.writeFileString(machineConfigPath, config);
      yield* setup(factoryDir);

      const logs: Array<string> = [];
      const capture = Logger.make(({ message }) => {
        logs.push(messageText(message));
      });

      yield* Effect.scoped(
        Layer.build(
          FactoryRuntime.pipe(
            Layer.provide(
              Layer.succeed(Paths.FactoryPaths, {
                baseDir,
                worktreesDir: join(baseDir, "worktrees"),
                factoryDir,
                machineConfigPath,
              }),
            ),
            Layer.provide(gh),
            Layer.provide(noSessions),
            Layer.provide(quietEvents),
          ),
        ),
      ).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));

      const gates = yield* fs
        .readDirectory(join(factoryDir, "gates"))
        .pipe(Effect.orElseSucceed(() => []));
      const events = scanMachineLog(factoryDir).map((entry) => entry.event);
      return { logs, machineConfigPath, gates, events };
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect("logs that there is no config when the machine file does not exist", () =>
  Effect.gen(function* () {
    const { logs, machineConfigPath, events } = yield* logsFor(undefined);
    assert.deepStrictEqual(logs, [`no factory config at ${machineConfigPath}`]);
    assert.deepStrictEqual(events, []);
  }),
);

it.effect("logs factory started once for a valid machine file, then runs the first pass", () =>
  Effect.gen(function* () {
    const { logs, events } = yield* logsFor(VALID);
    assert.strictEqual(logs[0], "factory started");
    // The pass found no gh: the repo's config could not be read, and the pass said so and ended.
    assert.ok(
      logs.some((line) => line.startsWith("error: a/b: project config not loaded")),
      logs.join("\n"),
    );
    assert.strictEqual(logs.at(-1), "pass done: 0 runs, 0 claimed, 1 errors, 0 need attention");
    assert.deepStrictEqual(events, ["pass_started", "repo_skipped", "pass_finished"]);
  }),
);

it.effect("logs each config error and does not start for an invalid machine file", () =>
  Effect.gen(function* () {
    const { logs, machineConfigPath } = yield* logsFor(
      VALID.replace("model: claude-sonnet-5-5\n", ""),
    );
    assert.deepStrictEqual(logs, [`${machineConfigPath}: model: is missing`]);
  }),
);

it.effect("clears the gate locks a dead server left and nothing else under gates", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { join } = yield* Path.Path;
    const { logs, gates } = yield* logsFor(VALID, (factoryDir) =>
      Effect.gen(function* () {
        const gatesDir = join(factoryDir, "gates");
        yield* fs.makeDirectory(gatesDir);
        yield* fs.writeFileString(join(gatesDir, "a.lock"), "");
        yield* fs.writeFileString(join(gatesDir, "b.lock"), "");
        yield* fs.writeFileString(join(gatesDir, "notes.txt"), "keep");
      }),
    );
    assert.deepStrictEqual(logs.slice(0, 2), ["cleared 2 gate lock(s)", "factory started"]);
    assert.deepStrictEqual(gates, ["notes.txt"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("logs each pass line as it is decided, so a pass that dies has said what it did", () =>
  Effect.gen(function* () {
    // The first repo's gh fails, which is a pass line; the second's call is a defect, which ends the pass.
    let calls = 0;
    const dying = Layer.succeed(
      FactoryProcess,
      FactoryProcess.of({
        run: () => {
          calls += 1;
          return calls === 1
            ? Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") }))
            : Effect.die(new Error("boom"));
        },
      }),
    );
    const { logs } = yield* logsFor(
      `${VALID}  - repo: c/d
    path: /d
`,
      () => Effect.void,
      dying,
    );
    assert.ok(
      logs.some((line) => line.startsWith("error: a/b: project config not loaded")),
      logs.join("\n"),
    );
    assert.ok(logs.includes("factory pass failed"), logs.join("\n"));
  }),
);

// ---- the wake ----

describe("waking the pass when a factory thread's run changes status", () => {
  /** A factory dir with a valid config and one unfinished run whose session is `thread-1`. */
  const seeded = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { join } = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-wake-" });
    const factoryDir = join(baseDir, "factory");
    yield* fs.makeDirectory(factoryDir);
    const machineConfigPath = join(factoryDir, "config.yml");
    yield* fs.writeFileString(machineConfigPath, VALID);
    const out = Ledger.create(factoryDir, newRunId("a/b", "1", 1));
    try {
      out.append(
        { event: "claimed", data: { machine: "m", github_user: "u" } },
        makeCause("start", "seed"),
      );
      out.append(
        {
          event: "session_launched",
          data: {
            thread_id: "thread-1",
            worktree: "/t3/wt",
            branch: "t3code/abc",
            model_instance: "claudeAgent",
            model: "claude-sonnet-5-5",
            resumed_from: null,
          },
        },
        makeCause("start", "seed"),
      );
    } finally {
      out.close();
    }
    return { baseDir, factoryDir, machineConfigPath, worktreesDir: join(baseDir, "worktrees") };
  });

  it.effect("a thread named by an unfinished run's session is owned; any other is not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factoryDir } = yield* seeded;
        assert.isTrue(yield* ownsThread(factoryDir, "thread-1"));
        assert.isFalse(yield* ownsThread(factoryDir, "thread-other"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("an owned thread starts the next pass, and a stream that failed is run again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { baseDir, factoryDir, machineConfigPath, worktreesDir } = yield* seeded;
        const queue = yield* Queue.unbounded<string>();
        // The first run of the stream fails; the one after it reads the queue.
        const failures = yield* Ref.make(1);
        const events = Layer.succeed(
          FactoryEvents,
          FactoryEvents.of({
            runStatusChanges: Stream.unwrap(
              Ref.modify(failures, (left) =>
                left > 0
                  ? ([
                      Stream.fail(new EventsError({ cause: new Error("gone") })),
                      left - 1,
                    ] as const)
                  : ([Stream.fromQueue(queue), 0] as const),
              ),
            ),
          }),
        );
        const loop = yield* Layer.build(
          factoryRuntime({ restartDelay: 0 }).pipe(
            Layer.provide(
              Layer.succeed(Paths.FactoryPaths, {
                baseDir,
                worktreesDir,
                factoryDir,
                machineConfigPath,
              }),
            ),
            Layer.provide(noGh),
            Layer.provide(noSessions),
            Layer.provide(events),
          ),
        ).pipe(Effect.map((context) => Context.get(context, FactoryLoop)));
        const started = () =>
          scanMachineLog(factoryDir).filter((entry) => entry.event === "pass_started").length;
        yield* Queue.offer(queue, "thread-other");
        yield* Queue.offer(queue, "thread-1");
        // The first pass, then the one the owned thread woke; the poll is a minute away.
        while (started() < 2) yield* loop.awaitPass;
        assert.isAtLeast(started(), 2);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

// ---- the live world over gh ----

describe("liveWorld", () => {
  const REPO = "rawphp/softfac";
  const NOW = Date.UTC(2026, 9, 8, 2, 0, 0);
  const MINUTE = 60 * 1000;

  /** A process that answers gh by its arguments and records every call. */
  const ghWith = (answer: (args: ReadonlyArray<string>) => string | null) => {
    const calls: Array<ReadonlyArray<string>> = [];
    const process = FactoryProcess.of({
      run: (input: RunInput) => {
        const args = input.args ?? [];
        calls.push(args);
        const stdout = answer(args);
        return Effect.succeed({
          exitCode: stdout === null ? 1 : 0,
          timedOut: false,
          tail: stdout ?? "",
          stderrTail: stdout === null ? "gh: Server Error (HTTP 502)" : "",
          truncated: false,
        } satisfies RunResult);
      },
    });
    return { process, calls };
  };

  const machine: MachineConfig = {
    ghConfigDir: "/gh/rawphp",
    pollSeconds: 60,
    maxConcurrentRuns: 1,
    maxConcurrentGates: 1,
    modelInstance: "claudeAgent",
    model: "claude-sonnet-5-5",
    repos: [{ repo: REPO, path: "/p" }],
  };

  const worldOf = (process: FactoryProcess["Service"]) =>
    liveWorld(machine, "/factory-test/data", process, stubSessions, () => NOW, "mac-mini");

  const repo: Repo = {
    watched: machine.repos[0]!,
    project: timeLimitOnlyProjectConfig(),
    trackerUser: "rawphp",
  };

  const isList = (args: ReadonlyArray<string>, label: string) =>
    args[0] === "issue" && args[1] === "list" && args.includes(label);

  const ago = (ms: number) => utcSecond(NOW - ms);

  it.effect("a ready issue anyone is assigned to is not listed", () =>
    Effect.gen(function* () {
      const { process } = ghWith((args) =>
        isList(args, "factory:ready")
          ? '[{"number":3,"title":"c","assignees":[]},{"number":2,"title":"b","assignees":[{"login":"eve"}]},{"number":1,"title":"a","assignees":[]}]'
          : null,
      );
      const listing = yield* worldOf(process).readyIssues(repo);
      assert.deepStrictEqual(listing, { items: [1, 3], cut: false });
    }),
  );

  it.effect(
    "a triage issue is listed only when the factory's login, in any case, is its only assignee",
    () =>
      Effect.gen(function* () {
        const { process } = ghWith((args) =>
          isList(args, "factory:triage")
            ? JSON.stringify([
                { number: 4, title: "d", assignees: [{ login: "RawPhp" }] },
                { number: 5, title: "e", assignees: [{ login: "rawphp" }, { login: "eve" }] },
                { number: 6, title: "f", assignees: [{ login: "eve" }] },
                { number: 7, title: "g", assignees: [] },
              ])
            : null,
        );
        const listing = yield* worldOf(process).triageIssues(repo);
        assert.deepStrictEqual(listing, { items: [4], cut: false });
      }),
  );

  /** The unassigned triage issue `updatedAt` ago; its history read fails, so a read shows as a failure. */
  const unassignedUpdated = (updated: number) =>
    Effect.gen(function* () {
      const { process, calls } = ghWith((args) =>
        isList(args, "factory:triage")
          ? JSON.stringify([{ number: 9, assignees: [], updatedAt: ago(updated) }])
          : isList(args, "factory:building")
            ? "[]"
            : null,
      );
      const result = yield* Effect.result(worldOf(process).unassignedClaims(repo));
      const historyRead = calls.some((args) => args[0] === "api" && args[1] === "graphql");
      return { result, historyRead };
    });

  it.effect("a claim changed within the last 15 minutes is not looked at", () =>
    Effect.gen(function* () {
      const { result, historyRead } = yield* unassignedUpdated(14 * MINUTE);
      assert.ok(result._tag === "Success" && result.success.length === 0);
      assert.isFalse(historyRead);
    }),
  );

  it.effect("a claim unchanged for more than 15 minutes has its history read", () =>
    Effect.gen(function* () {
      const { historyRead } = yield* unassignedUpdated(16 * MINUTE);
      assert.isTrue(historyRead);
    }),
  );

  /** gh for a release: the issue's comments (its newest factory comment is `newest`), and labels that move unless `labelFails`. */
  const releaseGh = (newest: string | null, labelFails: boolean) =>
    ghWith((args) => {
      if (args[0] === "api" && args[1] === `repos/${REPO}/issues/9/comments`) {
        return JSON.stringify(
          newest === null
            ? []
            : [{ id: 1, body: `${newest}\n\n${MARKER}`, created_at: "2026-10-08T01:00:00Z" }],
        );
      }
      if (args[0] === "issue" && args[1] === "comment") return "https://github.com/x/1";
      if (args[0] === "issue" && args[1] === "view") {
        return '{"labels":[{"name":"factory:triage"}]}';
      }
      if (args[0] === "issue" && args[1] === "edit") return labelFails ? null : "";
      return null;
    });

  const steps = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
    calls.map((args) =>
      args[0] === "api" ? "comments" : args[1] === "comment" ? "comment" : `${args[1]}`,
    );

  it.effect("a cut-short claim is commented on, then moved to proposed", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(null, false);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "comment", "view", "edit"]);
    }),
  );

  it.effect("a release whose label fails is tried again without a second comment", () =>
    Effect.gen(function* () {
      const first = releaseGh(null, true);
      const error = yield* Effect.flip(worldOf(first.process).releaseClaim(repo, 9, "triage"));
      assert.strictEqual(error.kind, "tracker");
      assert.deepStrictEqual(steps(first.calls), ["comments", "comment", "view", "edit"]);
      // The next pass finds the issue where it was, with the comment already its newest.
      const again = releaseGh(CUT_SHORT_COMMENT, false);
      yield* worldOf(again.process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(again.calls), ["comments", "view", "edit"]);
    }),
  );

  /** gh answers for `.dw/config.yml` on a default branch `main` whose config names `base`. */
  const baseConfigGh = (base: string) => {
    const sha = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
    const text = `factory:\n  instructors: [tomkaczocha]\n  base: ${base}\n  provision: []\n  gate: [make]\n  limits: { minutes: 1, gate_retries: 0 }\n  autonomy: pr\n`;
    const content = Buffer.from(text).toString("base64");
    return ghWith((args) => {
      const path = args[1] ?? "";
      if (args[0] !== "api") return null;
      if (path === `repos/${REPO}`) return '{"default_branch":"main"}';
      if (path === `repos/${REPO}/git/ref/heads/main`) {
        return JSON.stringify({ ref: "refs/heads/main", object: { sha, type: "commit" } });
      }
      if (path.startsWith(`repos/${REPO}/contents/`)) {
        return JSON.stringify({
          name: "config.yml",
          path: ".dw/config.yml",
          sha: "abc",
          size: text.length,
          type: "file",
          content,
          encoding: "base64",
        });
      }
      return null;
    });
  };

  it.effect("a project config committed on its own base branch is loaded", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh("main");
      const project = yield* worldOf(process).project(machine.repos[0]!);
      assert.strictEqual(project.base, "main");
    }),
  );

  it.effect("a project config that names another base is a config error naming both", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh("develop");
      const error = yield* Effect.flip(worldOf(process).project(machine.repos[0]!));
      assert.strictEqual(error.kind, "config");
      assert.include(error.message, "`develop`");
      assert.include(error.message, "`main`");
    }),
  );
});

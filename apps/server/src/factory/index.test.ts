import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { describe } from "vite-plus/test";

import { Attention } from "./attention.ts";
import { timeLimitOnlyProjectConfig, type MachineConfig } from "./config.ts";
import type { State } from "./domain/lifecycle.ts";
import {
  factoryRuntime,
  FactoryLoop,
  FactoryRuntime,
  liveWorld,
  ownedThreads,
  wakeOn,
} from "./index.ts";
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
    // The notification for the config item goes to a runner that accepts it, so it logs nothing.
    const { logs, machineConfigPath } = yield* logsFor(
      VALID.replace("model: claude-sonnet-5-5\n", ""),
      () => Effect.void,
      Layer.succeed(FactoryProcess, recordingProcess().process),
    );
    assert.deepStrictEqual(logs, [`${machineConfigPath}: model: is missing`]);
  }),
);

// ---- attention ----

/** A process runner that records each call: osascript succeeds and every other command fails to start. */
const recordingProcess = () => {
  const calls: Array<RunInput> = [];
  const process = FactoryProcess.of({
    run: (input) => {
      calls.push(input);
      return input.command === "osascript"
        ? Effect.succeed({
            exitCode: 0,
            timedOut: false,
            tail: "",
            stderrTail: "",
            truncated: false,
          } satisfies RunResult)
        : Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") }));
    },
  });
  return { calls, process };
};

describe("attention", () => {
  /** A base dir whose factory dir holds `config`, and the paths layer over it. */
  const dirWith = (config: string, seed?: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-attention-index-" });
      const factoryDir = join(baseDir, "factory");
      yield* fs.makeDirectory(factoryDir);
      const machineConfigPath = join(factoryDir, "config.yml");
      yield* fs.writeFileString(machineConfigPath, config);
      if (seed !== undefined) yield* fs.writeFileString(join(factoryDir, "attention.json"), seed);
      return { baseDir, factoryDir, machineConfigPath, worktreesDir: join(baseDir, "worktrees") };
    });

  /** Builds the runtime over `dirs`, and reads the open items while it runs. */
  const itemsAfterStart = (
    dirs: Effect.Success<ReturnType<typeof dirWith>>,
    process: FactoryProcess["Service"],
  ) =>
    Effect.scoped(
      Layer.build(
        FactoryRuntime.pipe(
          Layer.provide(Layer.succeed(Paths.FactoryPaths, dirs)),
          Layer.provide(Layer.succeed(FactoryProcess, process)),
          Layer.provide(noSessions),
          Layer.provide(quietEvents),
        ),
      ).pipe(Effect.flatMap((context) => Context.get(context, Attention).list())),
    );

  const INVALID = VALID.replace("model: claude-sonnet-5-5\n", "");

  it.effect("a machine config that does not load raises one config item and one notification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = yield* dirWith(INVALID);
        const { calls, process } = recordingProcess();
        const items = yield* itemsAfterStart(dirs, process);
        assert.deepStrictEqual(
          items.map((item) => [item.id, item.kind, item.repo]),
          [["config", "config", null]],
        );
        assert.include(items[0]!.message, "model: is missing");
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0]!.command, "osascript");
        assert.strictEqual(calls[0]!.args![0], "-e");
        assert.include(calls[0]!.args![1]!, "on run argv");
        assert.strictEqual(calls[0]!.args![2], "factory");
        assert.strictEqual(calls[0]!.args![3], items[0]!.message);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a config that loads clears the config item an earlier start left", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seed = JSON.stringify({
          items: [
            {
              id: "config",
              kind: "config",
              repo: null,
              issue: null,
              run: null,
              message: "machine config not loaded: x",
              first_seen: "2026-10-07T13:33:20.000Z",
            },
          ],
        });
        const dirs = yield* dirWith(VALID, seed);
        const { calls, process } = recordingProcess();
        assert.deepStrictEqual(yield* itemsAfterStart(dirs, process), []);
        assert.strictEqual(calls.filter((call) => call.command === "osascript").length, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a restart over the same files notifies nothing again and still lists the item", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = yield* dirWith(INVALID);
        const first = recordingProcess();
        const second = recordingProcess();
        yield* itemsAfterStart(dirs, first.process);
        const items = yield* itemsAfterStart(dirs, second.process);
        assert.strictEqual(first.calls.length, 1);
        assert.strictEqual(second.calls.length, 0);
        assert.deepStrictEqual(
          items.map((item) => item.id),
          ["config"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  /** Wakes the loop until a `pass-errors` item is open, for a config whose every pass errors (no gh). */
  const untilPassErrors = (config: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = yield* dirWith(config);
        const { calls, process } = recordingProcess();
        const context = yield* Layer.build(
          FactoryRuntime.pipe(
            Layer.provide(Layer.succeed(Paths.FactoryPaths, dirs)),
            Layer.provide(Layer.succeed(FactoryProcess, process)),
            Layer.provide(noSessions),
            Layer.provide(quietEvents),
          ),
        );
        const loop = Context.get(context, FactoryLoop);
        const attention = Context.get(context, Attention);
        const open = () =>
          attention
            .list()
            .pipe(Effect.map((items) => items.filter((item) => item.id === "pass-errors")));
        // Each wake is one more pass, and each wait is bounded so a pass that never ends fails
        // the test instead of hanging it.
        const reached = yield* Effect.gen(function* () {
          while ((yield* open()).length === 0) {
            yield* loop.wake;
            yield* Effect.timeoutOption(loop.awaitPass, "1 second");
          }
        }).pipe(Effect.timeoutOption("30 seconds"), Effect.map(Option.isSome));
        assert.isTrue(reached, "no pass-errors item was raised");
        return { items: yield* open(), osascript: calls.filter((c) => c.command === "osascript") };
      }),
    ).pipe(Effect.provide(NodeServices.layer));

  it.effect("passes that keep erroring raise a pass-errors item and one notification", () =>
    Effect.gen(function* () {
      const { items, osascript } = yield* untilPassErrors(VALID);
      assert.include(items[0]!.message, "3 times in a row");
      assert.include(items[0]!.message, "a/b: project config not loaded");
      assert.strictEqual(osascript.length, 1);
    }),
  );

  it.effect("notify: false keeps the item and posts nothing", () =>
    Effect.gen(function* () {
      const { items, osascript } = yield* untilPassErrors(`${VALID}notify: false\n`);
      assert.strictEqual(items.length, 1);
      assert.strictEqual(osascript.length, 0);
    }),
  );
});

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
  /** Writes an unfinished run of issue `issue` whose session is `threadId`. */
  const seedRun = (factoryDir: string, issue: number, threadId: string, finished = false) => {
    const out = Ledger.create(factoryDir, newRunId("a/b", String(issue), 1));
    try {
      out.append(
        { event: "claimed", data: { machine: "m", github_user: "u" } },
        makeCause("start", "seed"),
      );
      out.append(
        {
          event: "session_launched",
          data: {
            thread_id: threadId,
            worktree: "/t3/wt",
            branch: "t3code/abc",
            model_instance: "claudeAgent",
            model: "claude-sonnet-5-5",
            resumed_from: null,
          },
        },
        makeCause("start", "seed"),
      );
      if (finished) out.finish("stuck", null, null, makeCause("start", "seed"));
    } finally {
      out.close();
    }
  };

  /** A factory dir with a valid config and one unfinished run whose session is `thread-1`. */
  const seeded = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { join } = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-wake-" });
    const factoryDir = join(baseDir, "factory");
    yield* fs.makeDirectory(factoryDir);
    const machineConfigPath = join(factoryDir, "config.yml");
    yield* fs.writeFileString(machineConfigPath, VALID);
    seedRun(factoryDir, 1, "thread-1");
    return { baseDir, factoryDir, machineConfigPath, worktreesDir: join(baseDir, "worktrees") };
  });

  it.effect("owns the threads of unfinished runs' sessions, and no finished run's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factoryDir } = yield* seeded;
        seedRun(factoryDir, 2, "thread-done", true);
        assert.deepStrictEqual([...(yield* ownedThreads(factoryDir))], ["thread-1"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a thread the factory does not own never wakes the pass", () =>
    Effect.gen(function* () {
      const owned = yield* Ref.make<ReadonlySet<string>>(new Set(["thread-1"]));
      const wakes = yield* Ref.make(0);
      yield* wakeOn(
        owned,
        Stream.fromIterable(["thread-other", "thread-1", "thread-other"]),
        Ref.update(wakes, (n) => n + 1),
      );
      assert.strictEqual(yield* Ref.get(wakes), 1);
    }),
  );

  /** The factory's loop over the seeded dir, with `events` as T3's run status changes. */
  const loopOver = (
    dirs: Effect.Success<typeof seeded>,
    events: Stream.Stream<string, EventsError>,
  ) =>
    Layer.build(
      factoryRuntime({ restartDelay: 0 }).pipe(
        Layer.provide(Layer.succeed(Paths.FactoryPaths, dirs)),
        Layer.provide(noGh),
        Layer.provide(noSessions),
        Layer.provide(Layer.succeed(FactoryEvents, FactoryEvents.of({ runStatusChanges: events }))),
      ),
    ).pipe(Effect.map((context) => Context.get(context, FactoryLoop)));

  const countOf = (factoryDir: string, event: string) => () =>
    scanMachineLog(factoryDir).filter((entry) => entry.event === event).length;

  it.effect("a thread launched after the start is owned once a pass has ended", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = yield* seeded;
        const queue = yield* Queue.unbounded<string>();
        const loop = yield* loopOver(dirs, Stream.fromQueue(queue));
        const started = countOf(dirs.factoryDir, "pass_started");
        const finished = countOf(dirs.factoryDir, "pass_finished");
        // The poll is a minute away, so every pass here is the first or one a wake started. Each
        // wait is bounded so a wake that never comes fails the test instead of hanging it.
        const until = (done: () => boolean, each: Effect.Effect<unknown> = Effect.void) =>
          Effect.gen(function* () {
            while (!done()) {
              yield* each;
              yield* Effect.timeoutOption(loop.awaitPass, "1 second");
            }
          }).pipe(Effect.timeoutOption("30 seconds"), Effect.map(Option.isSome));
        assert.isTrue(yield* until(() => finished() >= 1), "the first pass never ended");
        seedRun(dirs.factoryDir, 2, "thread-2");
        const before = finished();
        yield* loop.wake;
        assert.isTrue(yield* until(() => finished() > before), "the woken pass never ended");
        // That pass read the new run's thread when it ended, so an event for the thread wakes the
        // next one. It is offered until it does: one offered before the read is not a wake.
        const after = started();
        const woke = yield* until(() => started() > after, Queue.offer(queue, "thread-2"));
        assert.isTrue(woke, "the new run's thread never woke the pass");
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
              Ref.modify(failures, (left): readonly [Stream.Stream<string, EventsError>, number] =>
                left > 0
                  ? [Stream.fail(new EventsError({ cause: new Error("gone") })), left - 1]
                  : [Stream.fromQueue(queue), 0],
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
        // The first pass, then the one the owned thread woke; the poll is a minute away. The wait is
        // bounded so a wake that never comes fails here. The count stays `>=`: the offer can land
        // while the first pass still runs, and a wake then is coalesced into that pass's latch.
        const waited = yield* Effect.gen(function* () {
          while (started() < 2) yield* loop.awaitPass;
        }).pipe(Effect.timeoutOption("30 seconds"));
        assert.isTrue(Option.isSome(waited), "the owned thread never woke the pass");
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
    notify: true,
    repos: [{ repo: REPO, path: "/p" }],
  };

  const worldOf = (process: FactoryProcess["Service"]) =>
    liveWorld(machine, "/factory-test/data", process, stubSessions, () => NOW, "mac-mini", {
      raise: () => Effect.void,
      clear: () => Effect.void,
    });

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
      const result = yield* Effect.result(
        worldOf(process).unassignedClaims(repo, new Set<number>()),
      );
      const historyRead = calls.some((args) => args[0] === "api" && args[1] === "graphql");
      return { result, historyRead };
    });

  it.effect("a claim changed within the last 15 minutes is not looked at", () =>
    Effect.gen(function* () {
      const { result, historyRead } = yield* unassignedUpdated(14 * MINUTE);
      assert.ok(result._tag === "Success" && result.success.claims.length === 0);
      assert.isFalse(historyRead);
    }),
  );

  it.effect("a claim unchanged for more than 15 minutes has its history read", () =>
    Effect.gen(function* () {
      const { historyRead } = yield* unassignedUpdated(16 * MINUTE);
      assert.isTrue(historyRead);
    }),
  );

  /** The approval history call, as `readHistory` sends it. */
  const isHistory = (args: ReadonlyArray<string>) => args[0] === "api" && args[1] === "graphql";

  /** A label added to the issue: its name, when, and by whom. */
  type Labeled = { readonly label: string; readonly at: string; readonly by?: string };

  /** A history whose only entries are these label events, oldest first, as the history read answers it. */
  const historyOf = (labeled: ReadonlyArray<Labeled>) =>
    JSON.stringify({
      data: {
        repository: {
          issue: {
            timelineItems: {
              totalCount: labeled.length,
              nodes: labeled.map(({ label, at, by }) => ({
                __typename: "LabeledEvent",
                createdAt: at,
                actor: { __typename: "User", login: by ?? "rawphp" },
                label: { name: label },
              })),
            },
            lastEditedAt: null,
            editor: null,
            userContentEdits: { totalCount: 0, nodes: [] },
          },
        },
      },
    });

  /** A label history in which `by` applied `factory:triage`. */
  const labelledByReply = (by: string) =>
    historyOf([{ label: "factory:triage", at: "2026-10-04T10:00:00Z", by }]);

  it.effect("a judgement that an issue is not the factory's lasts across passes of one world", () =>
    Effect.gen(function* () {
      const { process, calls } = ghWith((args) =>
        isList(args, "factory:triage")
          ? JSON.stringify([{ number: 9, assignees: [], updatedAt: ago(16 * MINUTE) }])
          : isList(args, "factory:building")
            ? "[]"
            : isHistory(args)
              ? labelledByReply("eve")
              : null,
      );
      const world = worldOf(process);
      const first = yield* world.unassignedClaims(repo, new Set<number>());
      const second = yield* world.unassignedClaims(repo, new Set<number>());
      assert.deepStrictEqual(first.claims, []);
      assert.deepStrictEqual(second.claims, []);
      assert.strictEqual(calls.filter(isHistory).length, 1);
    }),
  );

  it.effect(
    "a history read that fails is reported to the pass with the issue and the message",
    () =>
      Effect.gen(function* () {
        const { process } = ghWith((args) =>
          isList(args, "factory:triage")
            ? JSON.stringify([{ number: 9, assignees: [], updatedAt: ago(16 * MINUTE) }])
            : isList(args, "factory:building")
              ? "[]"
              : null,
        );
        const result = yield* worldOf(process).unassignedClaims(repo, new Set<number>());
        assert.deepStrictEqual(result.claims, []);
        assert.strictEqual(result.unread.length, 1);
        const unread = result.unread[0]!;
        assert.strictEqual(unread.issue, 9);
        assert.isTrue(unread.message.length > 0);
      }),
  );

  const OLD = "2026-07-01T01:00:00Z";
  const LABEL_AT = "2026-10-08T00:30:00Z";
  const COMMENT_AT = "2026-10-08T01:00:00Z";

  /**
   * gh for a release from `from`: the issue's comments (its newest factory comment is `newest`,
   * created at `commentAt`), the label history (`labels`, or null when the history cannot be
   * read), and the `from` label, which moves unless `labelFails`.
   */
  const releaseGh = (
    newest: string | null,
    labelFails: boolean,
    commentAt: string = COMMENT_AT,
    labels: ReadonlyArray<Labeled> | null = [{ label: "factory:triage", at: LABEL_AT }],
    from: State = "triage",
  ) =>
    ghWith((args) => {
      if (args[0] === "api" && args[1] === `repos/${REPO}/issues/9/comments`) {
        return JSON.stringify(
          newest === null ? [] : [{ id: 1, body: `${newest}\n\n${MARKER}`, created_at: commentAt }],
        );
      }
      if (isHistory(args)) return labels === null ? null : historyOf(labels);
      if (args[0] === "issue" && args[1] === "comment") return "https://github.com/x/1";
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ labels: [{ name: `factory:${from}` }] });
      }
      if (args[0] === "issue" && args[1] === "edit") return labelFails ? null : "";
      return null;
    });

  const steps = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
    calls.map((args) =>
      args[0] === "api"
        ? args[1] === "graphql"
          ? "history"
          : "comments"
        : args[1] === "comment"
          ? "comment"
          : `${args[1]}`,
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
      // The next pass finds the issue where it was: the comment is newer than the label event.
      const again = releaseGh(CUT_SHORT_COMMENT, false);
      yield* worldOf(again.process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(again.calls), ["comments", "history", "view", "edit"]);
    }),
  );

  it.effect("an old cut-short comment from before the current label is said again", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, OLD);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "history", "comment", "view", "edit"]);
    }),
  );

  it.effect(
    "a newest comment that is not the cut-short text is followed by one, unread history",
    () =>
      Effect.gen(function* () {
        const { process, calls } = releaseGh("Something else the factory said.", false);
        yield* worldOf(process).releaseClaim(repo, 9, "triage");
        assert.deepStrictEqual(steps(calls), ["comments", "comment", "view", "edit"]);
      }),
  );

  it.effect("a history that cannot be read still gets the comment, then the move", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, COMMENT_AT, null);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "history", "comment", "view", "edit"]);
    }),
  );

  it.effect("a history with no label event of the state gets the comment", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, COMMENT_AT, []);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "history", "comment", "view", "edit"]);
    }),
  );

  it.effect("a cut-short comment made in the label's own second is said again", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, LABEL_AT);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "history", "comment", "view", "edit"]);
    }),
  );

  /** A claim begun in triage that moved on to building at LABEL_AT. */
  const triageThenBuilding: ReadonlyArray<Labeled> = [
    { label: "factory:triage", at: OLD },
    { label: "factory:building", at: LABEL_AT },
  ];

  it.effect("a release from building compares with the building label, not triage", () =>
    Effect.gen(function* () {
      // Newer than the triage label, older than the building one: it explained the triage claim.
      const between = "2026-07-01T02:00:00Z";
      const old = releaseGh(CUT_SHORT_COMMENT, false, between, triageThenBuilding, "building");
      yield* worldOf(old.process).releaseClaim(repo, 9, "building");
      assert.deepStrictEqual(steps(old.calls), ["comments", "history", "comment", "view", "edit"]);
      const fresh = releaseGh(CUT_SHORT_COMMENT, false, COMMENT_AT, triageThenBuilding, "building");
      yield* worldOf(fresh.process).releaseClaim(repo, 9, "building");
      assert.deepStrictEqual(steps(fresh.calls), ["comments", "history", "view", "edit"]);
    }),
  );

  it.effect(
    "a comment time that is not GitHub's UTC-second form never counts, history unread",
    () =>
      Effect.gen(function* () {
        // Text-sorts after LABEL_AT, so only the form check keeps it from counting.
        const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, "2026-10-08T09:00:00+10:00");
        yield* worldOf(process).releaseClaim(repo, 9, "triage");
        assert.deepStrictEqual(steps(calls), ["comments", "comment", "view", "edit"]);
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

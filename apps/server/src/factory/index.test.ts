import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { FactoryRuntime } from "./index.ts";
import { scanMachineLog } from "./ledger/machineLog.ts";
import { FactoryProcess, RunSpawnError } from "./process.ts";
import * as Paths from "./t3/paths.ts";

/** A process runner on a machine with no `gh`: every call fails to start. */
const noGh = Layer.succeed(
  FactoryProcess,
  FactoryProcess.of({
    run: () => Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") })),
  }),
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
            Layer.provide(noGh),
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

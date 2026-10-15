import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import { FactoryRuntime } from "./index.ts";
import * as Paths from "./t3/paths.ts";

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
          ),
        ),
      ).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));

      const gates = yield* fs
        .readDirectory(join(factoryDir, "gates"))
        .pipe(Effect.orElseSucceed(() => []));
      return { logs, machineConfigPath, gates };
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect("logs that there is no config when the machine file does not exist", () =>
  Effect.gen(function* () {
    const { logs, machineConfigPath } = yield* logsFor(undefined);
    assert.deepStrictEqual(logs, [`no factory config at ${machineConfigPath}`]);
  }),
);

it.effect("logs factory started once for a valid machine file", () =>
  Effect.gen(function* () {
    const { logs } = yield* logsFor(VALID);
    assert.deepStrictEqual(logs, ["factory started"]);
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
    assert.deepStrictEqual(logs, ["cleared 2 gate lock(s)", "factory started"]);
    assert.deepStrictEqual(gates, ["notes.txt"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

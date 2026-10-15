import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import { FactoryRuntime } from "./index.ts";
import { FactoryPaths } from "./paths.ts";

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

/** Builds FactoryRuntime over a temp factory dir holding `config` (or no file) and returns the log lines. */
const logsFor = (config: string | undefined) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const factoryDir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-index-" });
      const machineConfigPath = join(factoryDir, "config.yml");
      if (config !== undefined) yield* fs.writeFileString(machineConfigPath, config);

      const logs: Array<string> = [];
      const capture = Logger.make(({ message }) => {
        logs.push(messageText(message));
      });

      yield* Effect.scoped(
        Layer.build(
          FactoryRuntime.pipe(
            Layer.provide(Layer.succeed(FactoryPaths, { factoryDir, machineConfigPath })),
          ),
        ),
      ).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));

      return { logs, machineConfigPath };
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

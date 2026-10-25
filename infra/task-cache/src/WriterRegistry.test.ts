import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { WriterSecrets } from "./deploymentConfig.ts";

const readKeys = Config.Redacted("DEVELOPER_KEYS").pipe(Effect.provide(WriterSecrets));

it.effect("loads the private writer registry as deployment configuration", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${home}/.config/t3-task-cache`, { recursive: true });
    yield* fs.writeFileString(`${home}/.config/t3-task-cache/writers.json`, '{"maria":"digest"}');
    const keys = yield* readKeys.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
    );
    expect(JSON.parse(Redacted.value(keys))).toEqual({ maria: "digest" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("uses explicit deployment credentials without requiring a local registry", () =>
  Effect.gen(function* () {
    const keys = yield* readKeys.pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ DEVELOPER_KEYS: '{"theo":"digest"}' })),
      ),
    );
    expect(JSON.parse(Redacted.value(keys))).toEqual({ theo: "digest" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails instead of deploying an empty registry when credentials are missing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    const result = yield* readKeys.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
      Effect.exit,
    );
    expect(Exit.isFailure(result)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("rejects reserved writer names without modifying credential stores", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const home = yield* fs.makeTempDirectoryScoped();
    const state = `${home}/.config/t3-task-cache`;
    yield* fs.makeDirectory(state, { recursive: true });
    const writers = '{"maria":"digest"}';
    const credentials = '{"https://cache.example":{"name":"maria","token":"secret"}}';
    yield* fs.writeFileString(`${state}/writers.json`, writers);
    yield* fs.writeFileString(`${state}/credentials.json`, credentials);
    for (const name of ["writers", "credentials"]) {
      const code = yield* spawner.exitCode(
        ChildProcess.make(
          "node",
          [`${import.meta.dirname}/../scripts/manage.ts`, "add-writer", name],
          {
            env: { HOME: home },
            extendEnv: true,
            stdout: "ignore",
            stderr: "ignore",
          },
        ),
      );
      expect(code).not.toBe(0);
      expect(yield* fs.readFileString(`${state}/writers.json`)).toBe(writers);
      expect(yield* fs.readFileString(`${state}/credentials.json`)).toBe(credentials);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import { WriterSecrets } from "./writers.ts";

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

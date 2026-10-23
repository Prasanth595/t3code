import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";

it.effect("never imports upstream's Local Storage, and records that nothing was found", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appDataDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-appdata-" });
    const userDataPath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-userdata-" });
    for (const upstreamName of ["T3 Code (Alpha)", "T3 Code (Dev)", "t3code"]) {
      const leveldb = path.join(appDataDirectory, upstreamName, "Local Storage", "leveldb");
      yield* fs.makeDirectory(leveldb, { recursive: true });
      yield* fs.writeFileString(path.join(leveldb, "000003.log"), "upstream draft");
    }

    const environment = {
      appDataDirectory,
      isDevelopment: false,
    } as DesktopEnvironment.DesktopEnvironment["Service"];

    yield* Effect.gen(function* () {
      const service = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage;
      yield* service.load(userDataPath);
      assert.deepEqual(yield* service.take, Option.none());
    }).pipe(
      Effect.provide(
        DesktopLegacyLocalStorage.layer.pipe(
          Layer.provide(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment)),
        ),
      ),
    );

    assert.isTrue(yield* fs.exists(path.join(userDataPath, "v1-local-storage-imported")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

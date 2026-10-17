import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each([
  { isDevelopment: false, platform: "darwin", folder: "t3code-factory" },
  { isDevelopment: true, platform: "darwin", folder: "t3code-factory-dev" },
  { isDevelopment: false, platform: "linux", folder: "t3code-factory" },
] as const)("uses the $folder profile folder", ({ isDevelopment, platform, folder }) =>
  Effect.gen(function* () {
    const userData = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment,
      platform,
    });
    assert.equal(userData, `/profiles/${folder}`);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["t3code", "t3code-v2", "T3 Code (Alpha)", "T3 Code (Dev)"])(
  "never reads upstream's %s profile, even on Windows or in development",
  (upstreamName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-profile-" });
      yield* fs.makeDirectory(path.join(directory, upstreamName), { recursive: true });
      yield* fs.writeFileString(path.join(directory, upstreamName, "Local State"), "upstream keys");

      const windows = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      const development = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: true,
        platform: "win32",
      });

      assert.equal(windows, path.join(directory, "t3code-factory"));
      assert.equal(development, path.join(directory, "t3code-factory-dev"));
      assert.isFalse(yield* fs.exists(path.join(windows, "Local State")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps an existing Windows profile's Local State", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-profile-" });
    const destination = path.join(directory, "t3code-factory");
    yield* fs.makeDirectory(destination, { recursive: true });
    yield* fs.writeFileString(path.join(destination, "Local State"), "fork state");

    const userData = yield* resolveUserDataPath({
      appDataDirectory: directory,
      isDevelopment: false,
      platform: "win32",
    });

    assert.equal(userData, destination);
    assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), "fork state");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { FORK_COMPILE_CACHE_DIR_NAME } from "./forkIdentity.ts";

it.effect("the desktop compile-cache preload mirrors the fork's cache folder name", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = yield* fs.readFileString(
      path.resolve(import.meta.dirname, "../../../apps/desktop/src/compileCache.ts"),
    );
    assert.include(source, `const FORK_COMPILE_CACHE_DIR_NAME = "${FORK_COMPILE_CACHE_DIR_NAME}";`);
  }).pipe(Effect.provide(NodeServices.layer)),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { FactoryPaths } from "../paths.ts";
import { FactoryPathsLive } from "./paths.ts";

it.effect("derives the factory paths from the server base directory", () =>
  Effect.gen(function* () {
    const { join } = yield* Path.Path;
    const { baseDir } = yield* ServerConfig;
    const paths = yield* FactoryPaths;

    assert.strictEqual(paths.factoryDir, join(baseDir, "factory"));
    assert.strictEqual(paths.machineConfigPath, join(baseDir, "factory", "config.yml"));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        FactoryPathsLive,
        ServerConfig.layerTest(process.cwd(), { prefix: "factory-paths-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);

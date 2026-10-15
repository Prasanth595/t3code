import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { FactoryPaths } from "../paths.ts";

/** The factory's files live in `<baseDir>/factory`. */
export const FactoryPathsLive = Layer.effect(
  FactoryPaths,
  Effect.gen(function* () {
    const { baseDir } = yield* ServerConfig;
    const { join } = yield* Path.Path;
    const factoryDir = join(baseDir, "factory");
    return { factoryDir, machineConfigPath: join(factoryDir, "config.yml") };
  }),
);

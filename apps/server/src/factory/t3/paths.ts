import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";

/**
 * Where the factory keeps and finds things on this machine, from the server's
 * base dir: the worktrees T3 makes for agent threads, and the factory's own
 * data under `<base>/factory` (the same layout as softfac's data dir, so its
 * retro can read both).
 */
export class FactoryPaths extends Context.Service<
  FactoryPaths,
  {
    readonly baseDir: string;
    readonly worktreesDir: string;
    readonly factoryDir: string;
  }
>()("t3/factory/t3/paths/FactoryPaths") {}

export const layer = Layer.effect(
  FactoryPaths,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return {
      baseDir: config.baseDir,
      worktreesDir: config.worktreesDir,
      factoryDir: path.join(config.baseDir, "factory"),
    };
  }),
);

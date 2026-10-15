import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as Paths from "./paths.ts";

it.effect(
  "takes the base dir and the worktrees dir from ServerConfig and puts factory data under <base>/factory",
  () =>
    Effect.gen(function* () {
      const paths = yield* Paths.FactoryPaths;
      assert.strictEqual(paths.baseDir, "/srv/t3fac");
      assert.strictEqual(paths.worktreesDir, "/srv/t3fac/worktrees");
      assert.strictEqual(paths.factoryDir, "/srv/t3fac/factory");
    }).pipe(
      Effect.provide(
        Paths.layer.pipe(
          Layer.provide(
            Layer.mock(ServerConfig.ServerConfig)({
              baseDir: "/srv/t3fac",
              worktreesDir: "/srv/t3fac/worktrees",
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

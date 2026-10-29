import { LocalSandboxDriver, type LocalSandboxConfig } from "@t3tools/sandbox-local/server/driver";
import {
  SandboxDriverKind,
  SandboxInstanceId,
  type SandboxInstanceConfig,
} from "@t3tools/sandbox-core/schema";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

export const BUILT_IN_SANDBOX_DRIVERS = [LocalSandboxDriver];

export const LOCAL_SANDBOX_INSTANCE_ID = SandboxInstanceId.make("local");

export const builtInSandboxInstances = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const localConfig = {
    root: path.join(config.baseDir, "sandboxes"),
  } satisfies LocalSandboxConfig;
  return [
    {
      instanceId: LOCAL_SANDBOX_INSTANCE_ID,
      driver: SandboxDriverKind.make("local"),
      enabled: true,
      config: localConfig,
    },
  ] satisfies ReadonlyArray<SandboxInstanceConfig>;
});

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { formatConfigError, loadMachineConfig } from "./config.ts";
import { clearGateLocks } from "./gate.ts";
import * as Paths from "./t3/paths.ts";

const start = Effect.gen(function* () {
  const { factoryDir, machineConfigPath } = yield* Paths.FactoryPaths;
  // Gates run inside this server, so a lock file left from an earlier run belongs to a dead gate.
  const cleared = yield* clearGateLocks(factoryDir);
  if (cleared > 0) yield* Effect.logInfo(`cleared ${cleared} gate lock(s)`);
  const loaded = yield* Effect.result(loadMachineConfig(machineConfigPath));
  if (Result.isFailure(loaded)) {
    for (const error of loaded.failure.errors) {
      yield* Effect.logError(formatConfigError(error));
    }
    return;
  }
  if (Option.isNone(loaded.success)) {
    yield* Effect.logInfo(`no factory config at ${machineConfigPath}`);
    return;
  }
  yield* Effect.logInfo("factory started");
});

/** Needs FactoryPaths and FileSystem; what index.test.ts builds with a test FactoryPaths. */
export const FactoryRuntime = Layer.effectDiscard(start);

/** The factory's root layer. server.ts merges it into the runtime; nothing else imports it. */
export const FactoryLayer = FactoryRuntime.pipe(Layer.provide(Paths.layer));

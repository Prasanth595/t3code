// With "local environment" off in desktop settings, a packaged build answers the web UI the way
// an upstream build does, so it does not hand out the factory server the bootstrap skipped.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import {
  getLocalEnvironmentBearerToken,
  getLocalEnvironmentBootstraps,
} from "../ipc/methods/window.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { factoryServerBootstrapsWhenPackaged } from "./factoryServer.ts";
import { factoryServerBearerToken, pairFactoryServer } from "./factoryServerIpc.ts";
import { layerDesktopEnvironment, layerHttpPairing, layerSafeStorage } from "./testing.ts";

// Partial stubs of the upstream services the handlers fall through to. The handlers read only
// `pool.list` and `localAuth.getBearerToken` on these paths, and full services are impractical.
const layerUpstreamBackend = Layer.mergeAll(
  Layer.succeed(
    DesktopBackendConfiguration.DesktopBackendConfiguration,
    {} as unknown as DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
  ),
  Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
    list: Effect.succeed([]),
  } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]),
  Layer.succeed(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
    getBearerToken: Effect.succeed("upstream-local-token"),
  } as unknown as DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth["Service"]),
);

const packagedWithSetting = (localEnvironmentEnabled: boolean) => {
  const settings = DesktopAppSettings.layerTest({
    ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
    localEnvironmentEnabled,
  });
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-factory-local-setting-test-",
      });
      return yield* effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            layerDesktopEnvironment(baseDir, true),
            layerSafeStorage,
            layerHttpPairing("stored-bearer"),
            settings,
            layerUpstreamBackend,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
};

describe("factory server and the local environment setting", () => {
  it.effect("is the primary environment when the setting is on", () =>
    packagedWithSetting(true)(
      Effect.gen(function* () {
        assert.equal(
          (yield* factoryServerBootstrapsWhenPackaged)?.[0]?.httpBaseUrl,
          "http://127.0.0.1:3876/",
        );
        assert.equal(yield* factoryServerBearerToken, "");
        yield* pairFactoryServer.handler("abc123");
        assert.equal(yield* getLocalEnvironmentBearerToken.handler(undefined), "stored-bearer");
        const bootstraps = (yield* getLocalEnvironmentBootstraps.handler()) as ReadonlyArray<{
          readonly httpBaseUrl: string;
        }>;
        assert.equal(bootstraps[0]?.httpBaseUrl, "http://127.0.0.1:3876/");
      }),
    ),
  );

  it.effect("steps aside for upstream's handlers when the setting is off", () =>
    packagedWithSetting(false)(
      Effect.gen(function* () {
        assert.isNull(yield* factoryServerBootstrapsWhenPackaged);
        assert.isNull(yield* factoryServerBearerToken);
        assert.deepEqual(yield* getLocalEnvironmentBootstraps.handler(), []);
        assert.equal(
          yield* getLocalEnvironmentBearerToken.handler(undefined),
          "upstream-local-token",
        );
      }),
    ),
  );
});

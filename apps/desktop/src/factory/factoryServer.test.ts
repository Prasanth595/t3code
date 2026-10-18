import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import { FORK_FACTORY_SERVER_URL } from "@t3tools/shared/forkIdentity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as DesktopState from "../app/DesktopState.ts";
import {
  factoryServerBootstraps,
  factoryServerBootstrapsWhenPackaged,
  openOnFactoryServer,
  usesFactoryServer,
} from "./factoryServer.ts";
import { layerAppActivation, layerDesktopEnvironment, layerWindow } from "./testing.ts";

describe("factory server as the primary environment", () => {
  it("points at the LaunchAgent server on 3876", () => {
    assert.equal(FORK_FACTORY_SERVER_URL, "http://127.0.0.1:3876");
  });

  it("is used by packaged builds only", () => {
    assert.isTrue(usesFactoryServer({ isPackaged: true }));
    assert.isFalse(usesFactoryServer({ isPackaged: false }));
  });

  it("publishes one primary bootstrap for the 3876 server, with no bootstrap token", () => {
    assert.deepEqual(factoryServerBootstraps(), [
      {
        id: PRIMARY_LOCAL_ENVIRONMENT_ID,
        label: "Factory server",
        runningDistro: null,
        httpBaseUrl: "http://127.0.0.1:3876/",
        wsBaseUrl: "ws://127.0.0.1:3876/",
      },
    ]);
  });

  const withLayers = <A, E, R>(
    isPackaged: boolean,
    readyUrls: Array<string>,
    starts: { count: number },
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-factory-server-test-",
      });
      // No backend pool is provided: a call that reached for one would die.
      return yield* effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            layerDesktopEnvironment(baseDir, isPackaged),
            layerWindow(readyUrls),
            layerAppActivation(starts),
            DesktopState.layer,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

  it.effect("a packaged build opens the window on 3876 and starts the app control socket", () => {
    const readyUrls: Array<string> = [];
    const starts = { count: 0 };
    return withLayers(
      true,
      readyUrls,
      starts,
      Effect.gen(function* () {
        assert.isTrue(yield* openOnFactoryServer);
        assert.deepEqual(readyUrls, ["http://127.0.0.1:3876/"]);
        assert.equal(starts.count, 1);
        assert.equal(
          (yield* factoryServerBootstrapsWhenPackaged)?.[0]?.httpBaseUrl,
          "http://127.0.0.1:3876/",
        );
      }),
    );
  });

  it.effect("a packaged build that is quitting opens nothing", () => {
    const readyUrls: Array<string> = [];
    const starts = { count: 0 };
    return withLayers(
      true,
      readyUrls,
      starts,
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);
        assert.isTrue(yield* openOnFactoryServer);
        assert.deepEqual(readyUrls, []);
        assert.equal(starts.count, 0);
      }),
    );
  });

  it.effect("a dev build changes nothing", () => {
    const readyUrls: Array<string> = [];
    const starts = { count: 0 };
    return withLayers(
      false,
      readyUrls,
      starts,
      Effect.gen(function* () {
        assert.isFalse(yield* openOnFactoryServer);
        assert.deepEqual(readyUrls, []);
        assert.equal(starts.count, 0);
        assert.isNull(yield* factoryServerBootstrapsWhenPackaged);
      }),
    );
  });

  it.effect("without a desktop environment the bootstraps stay upstream's", () =>
    Effect.gen(function* () {
      assert.isNull(yield* factoryServerBootstrapsWhenPackaged);
    }),
  );
});

// Runs upstream's real bootstrap to the factory hook. Without DesktopBackendPool provided,
// a bootstrap that got past `openOnFactoryServer` would die reaching for the pool, so the
// window opening on 3876 proves the hook stopped it.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  app: { setBadgeCount: () => true, on: () => undefined, removeListener: () => undefined },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
}));

import { bootstrap } from "../app/DesktopApp.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import {
  layerAppActivation,
  layerBootstrapStubs,
  layerDesktopEnvironment,
  layerIpcInstallDependencies,
  layerRecordingIpc,
  layerWindow,
} from "./testing.ts";

describe("desktop bootstrap", () => {
  it.effect("opens a packaged build on the factory server instead of starting a backend", () => {
    const readyUrls: Array<string> = [];
    const starts = { count: 0 };
    // bootstrap's type still names the backend services the hook bypasses.
    const run = bootstrap as unknown as Effect.Effect<void>;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-factory-bootstrap-test-",
      });
      yield* run.pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            layerDesktopEnvironment(baseDir, true),
            DesktopAppSettings.layerTest({
              ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
              localEnvironmentEnabled: true,
            }),
            DesktopState.layer,
            layerWindow(readyUrls),
            layerAppActivation(starts),
            layerBootstrapStubs,
            layerRecordingIpc([]),
            layerIpcInstallDependencies,
          ),
        ),
      );
      assert.deepEqual(readyUrls, ["http://127.0.0.1:3876/"]);
      assert.equal(starts.count, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
  });
});

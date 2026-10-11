import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const encoder = new TextEncoder();

const emptyNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {};
const lanNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {
  en0: [
    {
      address: "192.168.1.20",
      family: "IPv4",
      internal: false,
    },
  ],
};

const tailnetNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {
  tailscale0: [
    {
      address: "100.90.1.2",
      family: "IPv4",
      internal: false,
    },
  ],
};

function layerMockSpawner(statusJson = "{}", calls?: Array<ReadonlyArray<string>>, exitCode = 0) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      calls?.push("args" in command ? command.args : []);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(statusJson)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
}

function layerDieOnSpawn() {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unexpected tailscale spawn")),
  );
}

function layerEnvironmentFor(baseDir: string, env: Record<string, string | undefined> = {}) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir, ...env })),
    ),
  );
}

function layer(input: {
  readonly baseDir: string;
  readonly networkInterfaces?: DesktopNetworkInterfaces.NetworkInterfaces;
  readonly env?: Record<string, string | undefined>;
  readonly spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly desktopSettingsLayer?: Layer.Layer<DesktopAppSettings.DesktopAppSettings>;
}) {
  const env = { T3CODE_HOME: input.baseDir, ...input.env };
  const layerEnvironment = layerEnvironmentFor(input.baseDir, env);
  const layerNetwork = Layer.succeed(DesktopNetworkInterfaces.DesktopNetworkInterfaces, {
    read: Effect.succeed(input.networkInterfaces ?? emptyNetworkInterfaces),
  });

  return DesktopServerExposure.layer.pipe(
    Layer.provideMerge(input.desktopSettingsLayer ?? DesktopAppSettings.layer),
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(NodeHttpClient.layerUndici),
    Layer.provideMerge(input.spawnerLayer ?? layerMockSpawner()),
    Layer.provideMerge(layerNetwork),
    Layer.provideMerge(DesktopConfig.layerTest(env)),
    Layer.provideMerge(layerEnvironment),
  );
}

const withHarness = <A, E, R>(
  networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces,
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopServerExposure.DesktopServerExposure
    | DesktopAppSettings.DesktopAppSettings
  >,
  env: Record<string, string | undefined> = {},
  spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  desktopSettingsLayer?: Layer.Layer<DesktopAppSettings.DesktopAppSettings>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-server-exposure-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        layer({
          baseDir,
          networkInterfaces,
          env,
          ...(spawnerLayer ? { spawnerLayer } : {}),
          ...(desktopSettingsLayer ? { desktopSettingsLayer } : {}),
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopServerExposure", () => {
  it.effect("falls back to local-only without losing the requested network preference", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.setServerExposureMode("network-accessible");

        const state = yield* serverExposure.configureFromSettings({ port: 4173 });
        assert.equal(state.mode, "local-only");
        assert.equal(state.endpointUrl, null);
        assert.equal((yield* settings.get).serverExposureMode, "network-accessible");

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.bindHost, "127.0.0.1");
        assert.equal(backendConfig.httpBaseUrl.href, "http://127.0.0.1:4173/");
      }),
    ),
  );

  it.effect("returns a typed error when network access is explicitly unavailable", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const error = yield* serverExposure.setMode("network-accessible").pipe(Effect.flip);
        assert.ok(error._tag === "DesktopServerExposureNoNetworkAddressError");
        assert.equal(error.port, 4173);
      }),
    ),
  );

  it.effect("persists network-accessible mode and updates backend binding state", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.load;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const change = yield* serverExposure.setMode("network-accessible");
        assert.equal(change.requiresRelaunch, true);
        assert.deepEqual(change.state, {
          mode: "network-accessible",
          endpointUrl: "http://192.168.1.20:4173",
          advertisedHost: "192.168.1.20",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        });

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.bindHost, "0.0.0.0");
        assert.equal(backendConfig.httpBaseUrl.href, "http://127.0.0.1:4173/");

        const persisted = yield* settings.get;
        assert.equal(persisted.serverExposureMode, "network-accessible");
      }),
    ),
  );

  it.effect("persists tailscale serve preferences atomically and reports no-op updates", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.load;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const changed = yield* serverExposure.setTailscaleServeEnabled({
          enabled: true,
          port: 8443,
        });
        assert.equal(changed.requiresRelaunch, true);
        assert.equal(changed.state.tailscaleServeEnabled, true);
        assert.equal(changed.state.tailscaleServePort, 8443);

        const unchanged = yield* serverExposure.setTailscaleServeEnabled({
          enabled: true,
          port: 8443,
        });
        assert.equal(unchanged.requiresRelaunch, false);

        const persisted = yield* settings.get;
        assert.equal(persisted.tailscaleServeEnabled, true);
        assert.equal(persisted.tailscaleServePort, 8443);
      }),
    ),
  );

  it.effect.each([
    {
      name: "occupied",
      config: JSON.stringify({
        TCP: { "8443": { HTTPS: true } },
        Web: { "desktop.example:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } } },
      }),
      exitCode: 0,
    },
    { name: "unknown", config: JSON.stringify({ unexpected: true }), exitCode: 0 },
    { name: "unreadable", config: "invalid JSON", exitCode: 0 },
    { name: "command failure", config: "", exitCode: 1 },
  ])(
    "refuses $name Serve configuration without saving or changing runtime",
    ({ name, config, exitCode }) => {
      const calls: Array<ReadonlyArray<string>> = [];
      return withHarness(
        emptyNetworkInterfaces,
        Effect.gen(function* () {
          const exposure = yield* DesktopServerExposure.DesktopServerExposure;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* settings.load;
          yield* exposure.configureFromSettings({ port: 4173 });
          const previousSettings = yield* settings.get;
          const previousConfig = yield* exposure.backendConfig;
          const error = yield* exposure
            .setTailscaleServeEnabled({ enabled: true, port: 8443 })
            .pipe(Effect.flip);
          assert.instanceOf(error, DesktopServerExposure.DesktopTailscaleServeCheckError);
          assert.equal(error.reason, name === "occupied" ? "occupied" : "status-unavailable");
          assert.include(error.message, "tailscale serve status --json");
          if (name === "occupied") {
            assert.include(error.message, "8443");
            assert.include(error.message, "Choose another HTTPS port");
          }
          assert.deepEqual(yield* settings.get, previousSettings);
          assert.deepEqual(yield* exposure.backendConfig, previousConfig);
          assert.deepEqual(calls, [["serve", "status", "--json"]]);
        }),
        {},
        layerMockSpawner(config, calls, exitCode),
      );
    },
  );

  it.effect("allows a matching proxy for the actual runtime port without mutating Serve", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const config = JSON.stringify({
      TCP: { "8443": { HTTPS: true } },
      Web: { "desktop.example:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4173" } } } },
    });
    return withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const exposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* exposure.configureFromSettings({ port: 4173 });
        const change = yield* exposure.setTailscaleServeEnabled({ enabled: true, port: 8443 });
        assert.isTrue(change.requiresRelaunch);
        assert.isTrue(change.state.tailscaleServeEnabled);
        assert.deepEqual(calls, [["serve", "status", "--json"]]);
      }),
      {},
      layerMockSpawner(config, calls),
    );
  });

  it.effect("checks the saved Serve port when a new port is omitted", () => {
    const config = JSON.stringify({
      TCP: { "8443": { HTTPS: true } },
      Web: { "desktop.example:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } } },
    });
    return withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const exposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setTailscaleServe({ enabled: false, port: Option.some(8443) });
        yield* exposure.configureFromSettings({ port: 4173 });
        yield* exposure.setTailscaleServeEnabled({ enabled: true }).pipe(Effect.flip);
        assert.isFalse((yield* settings.get).tailscaleServeEnabled);
        assert.equal((yield* settings.get).tailscaleServePort, 8443);
      }),
      {},
      layerMockSpawner(config),
    );
  });

  it.effect.each([0, -1, 65_536, 443.5])(
    "checks the normalized port for invalid input %s",
    (port) => {
      const config = JSON.stringify({
        TCP: { "443": { HTTPS: true } },
        Web: { "desktop.example:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } } },
      });
      return withHarness(
        emptyNetworkInterfaces,
        Effect.gen(function* () {
          const exposure = yield* DesktopServerExposure.DesktopServerExposure;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* exposure.configureFromSettings({ port: 4173 });
          yield* exposure.setTailscaleServeEnabled({ enabled: true, port }).pipe(Effect.flip);
          assert.isFalse((yield* settings.get).tailscaleServeEnabled);
        }),
        {},
        layerMockSpawner(config),
      );
    },
  );

  it.effect("disables Serve without invoking the CLI", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const exposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setTailscaleServe({ enabled: true, port: Option.some(8443) });
        yield* exposure.configureFromSettings({ port: 4173 });
        const change = yield* exposure.setTailscaleServeEnabled({ enabled: false });
        assert.isTrue(change.requiresRelaunch);
        assert.isFalse(change.state.tailscaleServeEnabled);
        assert.isFalse((yield* settings.get).tailscaleServeEnabled);
      }),
      {},
      layerDieOnSpawn(),
    ),
  );

  it.effect("preserves persistence request context and the settings failure chain", () => {
    const diskFailure = new Error("disk exploded");
    const settingsFailure = new DesktopAppSettings.DesktopSettingsWriteError({
      operation: "replace-settings-file",
      path: "/tmp/desktop-settings.json",
      cause: diskFailure,
    });
    const layerSettings = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
      get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
      load: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
      setMainWindowBounds: () => Effect.die("unexpected main window bounds update"),
      setServerExposureMode: () => Effect.fail(settingsFailure),
      setTailscaleServe: () => Effect.fail(settingsFailure),
      setUpdateChannel: () => Effect.die("unexpected update channel change"),
      setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
      setWslDistro: () => Effect.die("unexpected WSL distro change"),
      setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
      setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
      applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
      applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
    } satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

    return withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const modeError = yield* serverExposure.setMode("network-accessible").pipe(Effect.flip);
        assert.instanceOf(
          modeError,
          DesktopServerExposure.DesktopServerExposureModePersistenceError,
        );
        assert.equal(modeError.mode, "network-accessible");
        assert.strictEqual(modeError.cause, settingsFailure);
        assert.strictEqual(modeError.cause.cause, diskFailure);
        assert.equal(
          modeError.message,
          "Failed to persist desktop server exposure mode network-accessible.",
        );
        assert.notInclude(modeError.message, diskFailure.message);

        const tailscaleError = yield* serverExposure
          .setTailscaleServeEnabled({ enabled: true, port: 8443 })
          .pipe(Effect.flip);
        assert.instanceOf(
          tailscaleError,
          DesktopServerExposure.DesktopTailscaleServePersistenceError,
        );
        assert.equal(tailscaleError.enabled, true);
        assert.equal(tailscaleError.port, 8443);
        assert.strictEqual(tailscaleError.cause, settingsFailure);
        assert.strictEqual(tailscaleError.cause.cause, diskFailure);
        assert.equal(
          tailscaleError.message,
          "Failed to persist desktop Tailscale Serve settings (enabled: true, port: 8443).",
        );
        assert.notInclude(tailscaleError.message, diskFailure.message);
      }),
      {},
      undefined,
      layerSettings,
    );
  });

  it.effect("keeps a Tailscale Serve change made while a mode change is saving", () =>
    Effect.gen(function* () {
      const modeWriteStarted = yield* Deferred.make<void>();
      const releaseModeWrite = yield* Deferred.make<void>();
      const settingsLayer = Layer.effect(
        DesktopAppSettings.DesktopAppSettings,
        Effect.gen(function* () {
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          return DesktopAppSettings.DesktopAppSettings.of({
            ...settings,
            // Hold the mode write the way a slow disk would.
            setServerExposureMode: (mode) =>
              Deferred.succeed(modeWriteStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseModeWrite)),
                Effect.andThen(settings.setServerExposureMode(mode)),
              ),
          });
        }),
      ).pipe(Layer.provide(DesktopAppSettings.layerTest()));

      return yield* withHarness(
        lanNetworkInterfaces,
        Effect.gen(function* () {
          const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
          yield* serverExposure.configureFromSettings({ port: 4173 });

          const modeChange = yield* serverExposure
            .setMode("network-accessible")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(modeWriteStarted);
          const tailscaleChange = yield* serverExposure
            .setTailscaleServeEnabled({ enabled: true, port: 8443 })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(releaseModeWrite, undefined);
          yield* Fiber.join(modeChange);
          yield* Fiber.join(tailscaleChange);

          const state = yield* serverExposure.getState;
          assert.equal(state.mode, "network-accessible");
          assert.equal(state.tailscaleServeEnabled, true);
          assert.equal(state.tailscaleServePort, 8443);
        }),
        {},
        undefined,
        settingsLayer,
      );
    }),
  );

  it.effect("keeps LAN and Tailscale endpoints distinct when Tailscale is enumerated first", () =>
    withHarness(
      { ...tailnetNetworkInterfaces, ...lanNetworkInterfaces },
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        yield* serverExposure.setMode("network-accessible");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://192.168.1.20:4173/", "http://100.90.1.2:4173/"],
        );
      }),
    ),
  );

  it.effect("keeps Tailscale-only hosts network-accessible", () =>
    withHarness(
      tailnetNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setServerExposureMode("network-accessible");

        const state = yield* serverExposure.configureFromSettings({ port: 4173 });
        assert.equal(state.mode, "network-accessible");
        assert.equal(state.advertisedHost, null);
        assert.equal(state.endpointUrl, null);
        assert.equal((yield* serverExposure.backendConfig).bindHost, "0.0.0.0");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => [endpoint.reachability, endpoint.httpBaseUrl]),
          [
            ["loopback", "http://127.0.0.1:4173/"],
            ["private-network", "http://100.90.1.2:4173/"],
          ],
        );
      }),
    ),
  );

  it.effect("does not spawn the tailscale CLI while server exposure is local-only", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        // mode stays at default "local-only", tailscaleServeEnabled stays false.

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        // Only the loopback endpoint; no tailscale spawn means the dieOnSpawnLayer
        // would have crashed the test if the gate was missing.
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/"],
        );
      }),
      {},
      layerDieOnSpawn(),
    ),
  );

  it.effect("preserves explicit Tailscale exposure overrides", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        const change = yield* serverExposure.setMode("network-accessible");

        assert.equal(change.state.advertisedHost, "100.90.1.2");
        assert.equal(change.state.endpointUrl, "http://100.90.1.2:4173");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://100.90.1.2:4173/", "https://public.example.test/"],
        );
      }),
      {
        T3CODE_DESKTOP_LAN_HOST: "100.90.1.2",
        T3CODE_DESKTOP_HTTPS_ENDPOINTS: "https://public.example.test",
      },
    ),
  );

  it.effect("advertises loopback, LAN, and configured manual endpoints from runtime state", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 3773 });
        yield* serverExposure.setMode("network-accessible");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(endpoints, [
          {
            id: "desktop-loopback:3773",
            label: "This machine",
            provider: {
              id: "desktop-core",
              label: "Desktop",
              kind: "core",
              isAddon: false,
            },
            httpBaseUrl: "http://127.0.0.1:3773/",
            wsBaseUrl: "ws://127.0.0.1:3773/",
            reachability: "loopback",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "desktop-core",
            status: "available",
            description: "Loopback endpoint for this desktop app.",
          },
          {
            id: "desktop-lan:http://192.168.1.20:3773",
            label: "Local network",
            provider: {
              id: "desktop-core",
              label: "Desktop",
              kind: "core",
              isAddon: false,
            },
            httpBaseUrl: "http://192.168.1.20:3773/",
            wsBaseUrl: "ws://192.168.1.20:3773/",
            reachability: "lan",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "desktop-core",
            status: "available",
            isDefault: true,
            description: "Reachable from devices on the same network.",
          },
          {
            id: "manual:https://desktop.example.ts.net",
            label: "Custom HTTPS",
            provider: {
              id: "manual",
              label: "Manual",
              kind: "manual",
              isAddon: false,
            },
            httpBaseUrl: "https://desktop.example.ts.net/",
            wsBaseUrl: "wss://desktop.example.ts.net/",
            reachability: "public",
            compatibility: {
              hostedHttpsApp: "compatible",
              desktopApp: "compatible",
            },
            source: "user",
            status: "unknown",
            description: "User-configured HTTPS endpoint for this desktop backend.",
          },
          {
            id: "manual:http://desktop.example.test:3773",
            label: "Custom endpoint",
            provider: {
              id: "manual",
              label: "Manual",
              kind: "manual",
              isAddon: false,
            },
            httpBaseUrl: "http://desktop.example.test:3773/",
            wsBaseUrl: "ws://desktop.example.test:3773/",
            reachability: "public",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "user",
            status: "unknown",
            description: "User-configured endpoint for this desktop backend.",
          },
        ]);
      }),
      {
        T3CODE_DESKTOP_HTTPS_ENDPOINTS:
          "https://desktop.example.ts.net,http://desktop.example.test:3773,not-a-url",
      },
    ),
  );
});

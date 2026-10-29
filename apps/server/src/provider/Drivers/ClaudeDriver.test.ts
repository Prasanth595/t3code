// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  createProviderVersionAdvisory,
  resolveLatestProviderVersion,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";
import { ClaudeManagedConfigDirectory } from "./ClaudeHome.ts";

// npm dist-tags for @anthropic-ai/claude-code when `stable` trails `latest`.
const DIST_TAGS: Record<string, string> = { stable: "2.1.308", latest: "2.1.312" };

// Records each requested dist-tag; tags in `unavailable` answer HTTP 503.
const makeNpmRegistry = (requested: Array<string>, unavailable: ReadonlyArray<string> = []) =>
  HttpClient.make((request) => {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").map(decodeURIComponent).filter(Boolean);
    const tag = segments.at(-1) ?? "";
    requested.push(tag);
    if (url.hostname !== "registry.npmjs.org" || !segments.join("/").includes("claude-code")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
      );
    }
    if (unavailable.includes(tag)) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
      );
    }
    const body =
      tag === "dist-tags"
        ? DIST_TAGS
        : tag in DIST_TAGS
          ? { name: "@anthropic-ai/claude-code", version: DIST_TAGS[tag] }
          : { name: "@anthropic-ai/claude-code", "dist-tags": DIST_TAGS };
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
  });

const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-driver-maintenance-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(Layer.mock(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner)({})),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, makeNpmRegistry([]))),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Version advisory resolution must not spawn a process"),
);

// A native launcher at 2.1.308 with the given user, managed and managed drop-in settings.
const makeNativeInstall = Effect.fn("makeNativeInstall")(function* (input: {
  readonly user: object;
  readonly managed?: object;
  readonly managedDropIns?: Record<string, object>;
  readonly unavailableTags?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs
    .makeTempDirectoryScoped({ prefix: "t3-claude-native-channel-" })
    .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
  const versionPath = NodePath.join(home, ".local", "share", "claude", "versions", "2.1.308");
  const launcherPath = NodePath.join(home, ".local", "bin", "claude");
  const managedDirectory = NodePath.join(home, "managed");
  const writeUserSettings = (settings: object) =>
    fs.writeFileString(NodePath.join(home, ".claude", "settings.json"), JSON.stringify(settings));
  yield* fs.makeDirectory(NodePath.dirname(versionPath), { recursive: true });
  yield* fs.writeFileString(versionPath, "#!/bin/sh\n");
  yield* fs.chmod(versionPath, 0o755);
  yield* fs.makeDirectory(NodePath.dirname(launcherPath), { recursive: true });
  yield* fs.symlink(versionPath, launcherPath);
  yield* fs.makeDirectory(NodePath.join(home, ".claude"));
  yield* writeUserSettings(input.user);
  yield* fs.makeDirectory(NodePath.join(managedDirectory, "managed-settings.d"), {
    recursive: true,
  });
  if (input.managed) {
    yield* fs.writeFileString(
      NodePath.join(managedDirectory, "managed-settings.json"),
      JSON.stringify(input.managed),
    );
  }
  for (const [name, settings] of Object.entries(input.managedDropIns ?? {})) {
    yield* fs.writeFileString(
      NodePath.join(managedDirectory, "managed-settings.d", name),
      JSON.stringify(settings),
    );
  }
  const requestedTags: Array<string> = [];

  const instance = yield* ClaudeDriver.create({
    instanceId: ProviderInstanceId.make("claude-native-channel"),
    displayName: "Claude update channel test",
    enabled: false,
    environment: [{ name: "HOME", value: home, sensitive: false }],
    config: { ...ClaudeDriver.defaultConfig(), binaryPath: launcherPath },
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, { HOME: home }),
    Effect.provideService(ClaudeManagedConfigDirectory, managedDirectory),
    Effect.provideService(
      HttpClient.HttpClient,
      makeNpmRegistry(requestedTags, input.unavailableTags),
    ),
  );
  const latestVersions = yield* ProviderLatestVersions.make();

  const resolveAdvisory = Effect.fn("resolveAdvisory")(function* (options?: {
    readonly fresh?: boolean;
  }) {
    const capabilities = yield* instance.snapshot.resolveMaintenance(options);
    const latestVersion = yield* resolveLatestProviderVersion(capabilities).pipe(
      Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
    );
    expect(capabilities.update).toMatchObject({ executable: launcherPath, args: ["update"] });
    return createProviderVersionAdvisory({
      driver: ClaudeDriver.driverKind,
      currentVersion: "2.1.308",
      latestVersion,
      maintenanceCapabilities: capabilities,
    });
  });
  return { requestedTags, writeUserSettings, resolveAdvisory };
});

const resolveNativeAdvisory = Effect.fn("resolveNativeAdvisory")(function* (
  input: Parameters<typeof makeNativeInstall>[0],
) {
  const install = yield* makeNativeInstall(input);
  return { requestedTags: install.requestedTags, advisory: yield* install.resolveAdvisory() };
});

it.layer(layerTest)("ClaudeDriver", (it) => {
  it.effect(
    "compares a native install on the stable update channel against npm's stable release",
    () =>
      Effect.gen(function* () {
        const { advisory } = yield* resolveNativeAdvisory({
          user: { autoUpdatesChannel: "stable" },
        });
        expect(advisory).toMatchObject({
          status: "current",
          latestVersion: "2.1.308",
        });
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect(
    "compares a native install on the latest update channel against npm's latest release",
    () =>
      Effect.gen(function* () {
        const { advisory } = yield* resolveNativeAdvisory({
          user: { autoUpdatesChannel: "latest" },
        });
        expect(advisory).toMatchObject({
          status: "behind_latest",
          latestVersion: "2.1.312",
        });
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect(
    "follows a managed update channel over the user's settings",
    () =>
      Effect.gen(function* () {
        const { advisory } = yield* resolveNativeAdvisory({
          user: { autoUpdatesChannel: "stable" },
          managed: { autoUpdatesChannel: "latest" },
        });
        expect(advisory).toMatchObject({
          status: "behind_latest",
          latestVersion: "2.1.312",
        });
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect(
    "follows the last managed drop-in's update channel over the base managed file",
    () =>
      Effect.gen(function* () {
        const { advisory } = yield* resolveNativeAdvisory({
          user: {},
          managed: { autoUpdatesChannel: "stable" },
          managedDropIns: {
            "10-telemetry.json": { env: {} },
            "20-updates.json": { autoUpdatesChannel: "latest" },
            "30-notes.txt": { autoUpdatesChannel: "stable" },
          },
        });
        expect(advisory).toMatchObject({
          status: "behind_latest",
          latestVersion: "2.1.312",
        });
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect(
    "follows a switched update channel after a fresh maintenance resolution",
    () =>
      Effect.gen(function* () {
        const install = yield* makeNativeInstall({ user: { autoUpdatesChannel: "stable" } });
        expect(yield* install.resolveAdvisory()).toMatchObject({
          status: "current",
          latestVersion: "2.1.308",
        });

        yield* install.writeUserSettings({ autoUpdatesChannel: "latest" });
        expect(yield* install.resolveAdvisory({ fresh: true })).toMatchObject({
          status: "behind_latest",
          latestVersion: "2.1.312",
        });

        yield* install.writeUserSettings({ autoUpdatesChannel: "stable" });
        expect(yield* install.resolveAdvisory({ fresh: true })).toMatchObject({
          status: "current",
          latestVersion: "2.1.308",
        });
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect(
    "reports no latest version when the stable channel's release cannot be fetched",
    () =>
      Effect.gen(function* () {
        const { advisory, requestedTags } = yield* resolveNativeAdvisory({
          user: { autoUpdatesChannel: "stable" },
          unavailableTags: ["stable"],
        });
        expect(advisory).toMatchObject({ status: "unknown", latestVersion: null });
        expect(requestedTags).toEqual(["stable"]);
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { GrokDriver } from "./driver.ts";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Grok must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Grok must not spawn a process"),
);

/** Answers every spawn with `onSpawn`'s stdout and records `[command, ...args]`. */
function brewSpawner(
  spawned: Array<ReadonlyArray<string>>,
  onSpawn: (args: ReadonlyArray<string>) => string,
) {
  return ChildProcessSpawner.make((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    spawned.push([executable, ...args]);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(onSpawn(args))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

/** `<root>/Caskroom/grok-build/1.0.50/<binary>` linked from `<root>/bin/grok`, with `<root>/bin/brew`. */
const makeCaskInstall = Effect.fn("makeCaskInstall")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const caskBinary = path.join(root, "Caskroom", "grok-build", "1.0.50", "grok-1.0.50");
  const brewPath = path.join(root, "bin", "brew");
  const linkPath = path.join(root, "bin", "grok");
  yield* fs.makeDirectory(path.dirname(caskBinary), { recursive: true });
  yield* fs.makeDirectory(path.dirname(brewPath), { recursive: true });
  for (const executable of [caskBinary, brewPath]) {
    yield* fs.writeFileString(executable, "#!/bin/sh\n");
    yield* fs.chmod(executable, 0o755);
  }
  yield* fs.symlink(caskBinary, linkPath);
  return { brewPath, linkPath };
});

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(layerTest)("GrokDriver", (it) => {
  it.effect.skipIf(windowsHost)("updates through the configured executable's own updater", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-driver-" });
      const grokHome = path.join(tempDir, "Grok Home");
      const binaryPath = path.join(grokHome, "bin", "grok");
      yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
      yield* fs.chmod(binaryPath, 0o755);

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-update"),
        displayName: "Grok test",
        enabled: false,
        environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
        config: { ...GrokDriver.defaultConfig(), binaryPath },
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.packageName).toBe("@xai-official/grok");
      expect(capabilities.update).toMatchObject({
        command: `'${binaryPath}' update`,
        executable: binaryPath,
        args: ["update"],
      });
      // `grok update` installs under GROK_HOME, so it must target this instance's home.
      expect(capabilities.update?.env?.GROK_HOME).toBe(grokHome);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect.skipIf(windowsHost)("upgrades a Homebrew cask install with brew, not grok update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-cask-" }),
      );
      const { brewPath, linkPath } = yield* makeCaskInstall(root);
      const spawned: Array<ReadonlyArray<string>> = [];

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-cask"),
        displayName: "Grok test",
        enabled: false,
        environment: [],
        config: { ...GrokDriver.defaultConfig(), binaryPath: linkPath },
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          brewSpawner(spawned, (args) =>
            args[0] === "--prefix"
              ? `${root}\n`
              : JSON.stringify({ casks: [{ version: "1.0.50" }] }),
          ),
        ),
      );

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(spawned).toEqual([
        [brewPath, "--prefix"],
        [brewPath, "info", "--json=v2", "grok-build"],
      ]);
      // The advisory compares against the cask, which trails npm's `latest`.
      expect(capabilities.latestVersion).toBe("1.0.50");
      expect(capabilities.update).toMatchObject({
        command: "brew upgrade --cask grok-build",
        executable: brewPath,
        args: ["upgrade", "--cask", "grok-build"],
        lockKey: "homebrew",
      });
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "keeps grok update when the cask is not under the resolved brew's prefix",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-foreign-cask-" }),
        );
        const { linkPath } = yield* makeCaskInstall(root);

        const instance = yield* GrokDriver.create({
          instanceId: ProviderInstanceId.make("grok-foreign-cask"),
          displayName: "Grok test",
          enabled: false,
          environment: [],
          config: { ...GrokDriver.defaultConfig(), binaryPath: linkPath },
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            brewSpawner([], () => "/opt/homebrew\n"),
          ),
        );

        const capabilities = yield* instance.snapshot.resolveMaintenance();
        expect(capabilities.latestVersion).toBeUndefined();
        expect(capabilities.update).toMatchObject({
          executable: linkPath,
          args: ["update"],
          lockKey: "grok",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-missing-" });
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-missing"),
        displayName: "Grok test",
        enabled: false,
        environment: [],
        config: { ...GrokDriver.defaultConfig(), binaryPath: path.join(tempDir, "grok") },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );
});

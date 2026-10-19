import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as NetService from "@t3tools/shared/Net";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  AGENT_DEVICE_VERSION,
  DEVICE_HUB_VERSION,
  agentDeviceStateDir,
} from "./DeviceToolchain.ts";

const processOutput = (code: number, stdout = "", stderr = "", timedOut = false) => ({
  code: ChildProcessSpawner.ExitCode(code),
  stdout,
  stderr,
  timedOut,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const agentFixture = Effect.fn("agentFixture")(function* (
  startup: (
    stateDir: string,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-agent-start-" });
  const stateDir = agentDeviceStateDir(path, path.join(baseDir, "userdata"));
  for (const [name, version, entry] of [
    ["expo-device-hub", DEVICE_HUB_VERSION, "dist/server/cli.mjs"],
    ["agent-device", AGENT_DEVICE_VERSION, "bin/agent-device.mjs"],
  ]) {
    const installDir = path.join(baseDir, "tools", name!, version!);
    const entryPath = path.join(installDir, "node_modules", name!, entry!);
    yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
    yield* fs.writeFileString(entryPath, "");
    yield* fs.writeFileString(path.join(installDir, ".install-complete"), version!);
  }
  const host = yield* LocalDeviceHost.make().pipe(
    Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
    Effect.provideService(HostProcess.Environment, { HOME: baseDir, PATH: "" }),
    Effect.provideService(HostProcess.IsExecutable, false),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(123),
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
      ),
    ),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) =>
        input.args.includes("devices") ? startup(stateDir) : Effect.succeed(processOutput(0)),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
      ),
    ),
  );
  yield* host.ensureReady(() => Effect.void);
  return { host, fs, stateDir };
});

describe("AgentDevice startup", () => {
  it.effect("reports an incompatible lock immediately and retains it for manual repair", () =>
    Effect.gen(function* () {
      const result = processOutput(
        1,
        JSON.stringify({
          success: false,
          error: {
            message: "private command output",
            details: {
              reason: "daemon_registration_unproven",
              inspection: { state: "unproven", reason: "non-directory" },
            },
          },
        }),
      );
      const { host, fs, stateDir } = yield* agentFixture(() => Effect.succeed(result));
      const lock = `${stateDir}/daemon.lock`;
      const legacyOwner = JSON.stringify({ pid: 85669, processStartTime: "old start time" });
      yield* fs.writeFileString(lock, legacyOwner);
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AgentDeviceStartError",
        reason: "daemon_lock_not_directory",
        exitCode: 1,
        cause: result,
      });
      expect(error.message).toContain("Daemon registration ownership could not be verified");
      expect(error.message).toContain("daemon.lock is not a directory");
      expect(error.message).toContain(stateDir);
      expect(error.message).toContain("original CLI");
      expect(error.message).not.toContain("private command output");
      expect(yield* fs.readFileString(lock)).toBe(legacyOwner);
      expect(yield* host.current).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports unknown nonzero exits without exposing arbitrary command output", () =>
    Effect.gen(function* () {
      const result = processOutput(2, "invalid JSON", "private credentials");
      const { host, stateDir } = yield* agentFixture(() => Effect.succeed(result));
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "AgentDeviceStartError",
        reason: "command_failed",
        exitCode: 2,
        cause: result,
      });
      expect(error.message).toContain("exit code 2");
      expect(error.message).toContain(stateDir);
      expect(error.message).not.toContain("private credentials");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves process execution failures instead of waiting for a daemon file", () =>
    Effect.gen(function* () {
      const cause = new ProcessRunner.ProcessSpawnError({
        command: "/missing/node",
        argumentCount: 3,
        cause: new Error("missing executable"),
      });
      const { host } = yield* agentFixture(() => Effect.fail(cause));
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DeviceHostError",
        step: "starting agent tools",
        cause,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns a command timeout without starting another readiness wait", () =>
    Effect.gen(function* () {
      const { host } = yield* agentFixture(() => Effect.succeed(processOutput(124, "", "", true)));
      const error = yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "DeviceHostTimeoutError", timeoutMs: 30_000 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses a registered daemon when reading startup command output fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cause = new ProcessRunner.ProcessReadError({
        command: process.execPath,
        argumentCount: 3,
        stream: "stdout",
        cause: new Error("output read failed after registration"),
      });
      let attempts = 0;
      const { host } = yield* agentFixture((stateDir) =>
        Effect.gen(function* () {
          attempts++;
          yield* fs
            .writeFileString(
              `${stateDir}/daemon.json`,
              JSON.stringify({ httpPort: 12345, token: "test-token" }),
            )
            .pipe(Effect.orDie);
          return yield* cause;
        }),
      );
      const ready = yield* host.ensureAgentReady(() => Effect.void);
      expect(ready.agentDevice).toMatchObject({
        baseUrl: "http://127.0.0.1:12345",
        token: "test-token",
      });
      expect((yield* host.ensureAgentReady(() => Effect.void)).agentDevice).toEqual(
        ready.agentDevice,
      );
      expect(attempts).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("allows retry and uses a registered daemon even when discovery exits nonzero", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let attempts = 0;
      const { host } = yield* agentFixture((stateDir) =>
        Effect.gen(function* () {
          attempts++;
          if (attempts > 1) {
            yield* fs
              .writeFileString(
                `${stateDir}/daemon.json`,
                JSON.stringify({ httpPort: 12345, token: "test-token" }),
              )
              .pipe(Effect.orDie);
          }
          return processOutput(1);
        }),
      );
      yield* host.ensureAgentReady(() => Effect.void).pipe(Effect.flip);
      const ready = yield* host.ensureAgentReady(() => Effect.void);
      expect(ready.agentDevice).toMatchObject({
        baseUrl: "http://127.0.0.1:12345",
        token: "test-token",
      });
      expect((yield* host.ensureAgentReady(() => Effect.void)).agentDevice).toEqual(
        ready.agentDevice,
      );
      expect(attempts).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const diagnose = (
  files: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = "darwin",
) =>
  LocalDeviceHost.__testing.platformReason("android").pipe(
    Effect.provideService(HostProcess.Environment, environment),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: () => Effect.die("Android diagnostics must not run commands"),
    }),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (file) => Effect.succeed(files.includes(file)),
      }),
    ),
    Effect.provide(platform === "win32" ? NodePath.layerWin32 : NodePath.layerPosix),
  );

const diagnoseIos = (
  outcome: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
  applications: ReadonlyArray<string> = ["Xcode.app"],
  platform: NodeJS.Platform = "darwin",
) =>
  LocalDeviceHost.__testing.platformReason("ios").pipe(
    Effect.provideService(HostProcess.Environment, { PATH: "" }),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: (input) => {
        expect(platform).toBe("darwin");
        expect([input.command, ...input.args]).toEqual(["xcrun", "simctl", "help"]);
        const timeoutMs = Duration.toMillis(input.timeout ?? Infinity);
        expect(Number.isFinite(timeoutMs)).toBe(true);
        expect(timeoutMs).toBeGreaterThan(0);
        return outcome;
      },
    }),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        readDirectory: (path) => {
          expect(path).toBe("/Applications");
          return Effect.succeed([...applications]);
        },
        exists: (path) =>
          Effect.succeed(
            applications.some((bundle) => path === `/Applications/${bundle}/Contents/Developer`),
          ),
      }),
    ),
    Effect.provide(NodePath.layerPosix),
  );

describe("iOS Simulator availability", () => {
  it.effect("accepts working simctl on macOS and rejects other platforms without probing", () =>
    Effect.gen(function* () {
      expect(yield* diagnoseIos(Effect.succeed(processOutput(0)))).toBeNull();
      for (const platform of ["linux", "win32"] as const) {
        expect(yield* diagnoseIos(Effect.die("Only macOS can probe simctl"), [], platform)).toMatch(
          /macOS.*Xcode/,
        );
      }
    }),
  );

  it.effect("offers a usable xcode-select command for the installed Xcode bundle", () =>
    Effect.gen(function* () {
      for (const bundle of ["Xcode.app", "Xcode-beta.app", "Xcode 26.app"]) {
        const reason = yield* diagnoseIos(
          Effect.succeed(processOutput(72, "", 'xcrun: error: unable to find utility "simctl"')),
          ["Safari.app", bundle],
        );
        const developerPath = `/Applications/${bundle}/Contents/Developer`;
        expect(reason).toContain(developerPath);
        const command = reason?.match(/sudo xcode-select (?:-s|--switch) (.+)/)?.[1];
        expect(command).toBeDefined();
        const quoted =
          command?.startsWith(`"${developerPath}"`) || command?.startsWith(`'${developerPath}'`);
        expect(quoted || (!bundle.includes(" ") && command?.startsWith(developerPath))).toBe(true);
      }
    }),
  );

  it.effect("offers installation or selection outside Applications when no Xcode is found", () =>
    Effect.gen(function* () {
      const reason = yield* diagnoseIos(
        Effect.succeed(processOutput(72, "", 'xcrun: error: unable to find utility "simctl"')),
        ["Safari.app"],
      );
      expect(reason).toMatch(/install Xcode/i);
      expect(reason).toContain("outside /Applications");
      expect(reason).toContain("xcode-select");
      expect(reason).not.toContain("/Applications/Xcode.app");
    }),
  );

  it.effect("reports missing tools only for a not-found spawn failure", () =>
    Effect.gen(function* () {
      for (const [cause, missing] of [
        [
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            pathOrDescriptor: "xcrun",
          }),
          true,
        ],
        [
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "ChildProcess",
            method: "spawn",
            pathOrDescriptor: "xcrun",
          }),
          false,
        ],
        [new Error("unknown spawn failure"), false],
      ] as const) {
        const reason = yield* diagnoseIos(
          Effect.fail(
            new ProcessRunner.ProcessSpawnError({ command: "xcrun", argumentCount: 2, cause }),
          ),
        );
        if (missing) {
          expect(reason).toMatch(/command line tools.*not found/i);
        } else {
          expect(reason).toMatch(/could not run xcrun simctl/i);
          expect(reason).not.toMatch(/not found|install Xcode|xcode-select/i);
        }
      }
    }),
  );

  it.effect("preserves license and timeout diagnostics without suggesting missing tools", () =>
    Effect.gen(function* () {
      for (const [outcome, diagnostic] of [
        [
          Effect.succeed(
            processOutput(69, "", "You have not agreed to the Xcode license agreements."),
          ),
          /license agreements/,
        ],
        [
          Effect.fail(
            new ProcessRunner.ProcessTimeoutError({
              command: "xcrun",
              argumentCount: 2,
              timeoutMs: 15_000,
            }),
          ),
          /timed out/i,
        ],
        [Effect.succeed(processOutput(124, "", "", true)), /timed out/i],
      ] as const) {
        const reason = yield* diagnoseIos(outcome);
        expect(reason).toMatch(diagnostic);
        expect(reason).not.toMatch(/not found|install Xcode|xcode-select/i);
      }
    }),
  );
});

describe("Android SDK availability", () => {
  it.effect("uses the standard Windows SDK without probing PATH", () =>
    Effect.gen(function* () {
      const root = "C:\\Users\\test\\AppData\\Local\\Android\\Sdk";
      const probes: string[] = [];
      const sdk = yield* LocalDeviceHost.__testing.androidSdk.pipe(
        Effect.provideService(HostProcess.Environment, {
          USERPROFILE: "C:\\Users\\test",
          LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
          PATH: "\\\\slow-share\\tools;C:\\other-tools",
        }),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: (file) =>
              Effect.sync(() => {
                probes.push(file);
                return file === `${root}\\platform-tools\\adb.exe`;
              }),
            realPath: () => Effect.die("Standard SDK must not resolve PATH executables"),
          }),
        ),
        Effect.provide(NodePath.layerWin32),
      );
      expect(sdk).toMatchObject({ root, adb: true });
      expect(probes.filter((file) => !file.startsWith("C:\\Users\\test\\"))).toEqual([]);
    }),
  );

  it.effect("falls back to adb on the Windows Path without resolving missing entries", () =>
    Effect.gen(function* () {
      const root = "D:\\Android\\Sdk";
      const resolved: string[] = [];
      const sdk = yield* LocalDeviceHost.__testing.androidSdk.pipe(
        Effect.provideService(HostProcess.Environment, {
          USERPROFILE: "C:\\Users\\test",
          Path: "C:\\missing;C:\\shims",
        }),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            exists: (file) =>
              Effect.succeed(
                file === "C:\\shims\\adb.exe" || file === `${root}\\platform-tools\\adb.exe`,
              ),
            realPath: (file) =>
              Effect.sync(() => {
                resolved.push(file);
                return `${root}\\platform-tools\\adb.exe`;
              }),
          }),
        ),
        Effect.provide(NodePath.layerWin32),
      );
      expect(sdk).toMatchObject({ root, adb: true });
      expect(resolved).toEqual(["C:\\shims\\adb.exe"]);
    }),
  );

  it.effect("explains that adb alone is insufficient to launch an emulator", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb"], { ANDROID_HOME: "/sdk" });
      expect(reason).toContain("Android Emulator is missing");
    }),
  );

  it.effect("identifies command-line tools required by the device hub", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(["/sdk/platform-tools/adb", "/sdk/emulator/emulator"], {
        ANDROID_HOME: "/sdk",
      });
      expect(reason).toContain("Command-line Tools (latest) are missing");
    }),
  );

  it.effect("explains how to upgrade legacy command-line tools in the standard macOS SDK", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [`${root}/platform-tools/adb`, `${root}/emulator/emulator`, `${root}/tools/bin/avdmanager`],
        { HOME: "/test/home" },
      );
      expect(reason).toContain("older, unsupported version");
      expect(reason).toContain(root);
      expect(reason).toContain(
        "Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools.",
      );
    }),
  );

  it.effect("recognizes legacy command-line tools on Windows", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "C:\\Android\\Sdk\\platform-tools\\adb.exe",
          "C:\\Android\\Sdk\\emulator\\emulator.exe",
          "C:\\Android\\Sdk\\tools\\bin\\avdmanager.bat",
        ],
        { ANDROID_HOME: "C:\\Android\\Sdk" },
        "win32",
      );
      expect(reason).toContain("older, unsupported version");
    }),
  );

  it.effect("accepts the latest command-line tools when legacy tools are also installed", () =>
    Effect.gen(function* () {
      const reason = yield* diagnose(
        [
          "/sdk/platform-tools/adb",
          "/sdk/emulator/emulator",
          "/sdk/tools/bin/avdmanager",
          "/sdk/cmdline-tools/latest/bin/avdmanager",
        ],
        { ANDROID_HOME: "/sdk" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("discovers the standard macOS SDK without ANDROID_HOME", () =>
    Effect.gen(function* () {
      const root = "/test/home/Library/Android/sdk";
      const reason = yield* diagnose(
        [
          `${root}/platform-tools/adb`,
          `${root}/emulator/emulator`,
          `${root}/cmdline-tools/latest/bin/avdmanager`,
        ],
        { HOME: "/test/home" },
      );
      expect(reason).toBeNull();
    }),
  );

  it.effect("reports an absent SDK without running or installing tools", () =>
    Effect.gen(function* () {
      expect(yield* diagnose([], { HOME: "/test/home" })).toContain("Android SDK was not found");
    }),
  );
});

it.effect("puts detected Android tools on the helper PATH without losing existing commands", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const environment = LocalDeviceHost.__testing.deviceHostEnvironment(
      { PATH: "/usr/bin", HOME: "/test/home" },
      "/sdk",
      "darwin",
      path,
    );
    expect(environment.PATH).toBe("/sdk/platform-tools:/sdk/emulator:/usr/bin");
    expect(environment.ANDROID_HOME).toBe("/sdk");
    expect(environment.HOME).toBe("/test/home");
  }).pipe(Effect.provide(NodePath.layerPosix)),
);

it.effect(
  "recovers an owned Linux runtime directory without overriding explicit environments",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const stat = yield* fs.stat(directory);
      for (const [platform, uid, runtimeDir, type, owner, expected] of [
        ["linux", 1000, undefined, "Directory", 1000, "/run/user/1000"],
        ["linux", 1000, "/custom/runtime", "Directory", 1000, "/custom/runtime"],
        ["linux", 1000, "", "Directory", 1000, ""],
        ["linux", 1000, undefined, "Directory", 1001, undefined],
        ["linux", 1000, undefined, "File", 1000, undefined],
        ["linux", undefined, undefined, "Directory", 1000, undefined],
        ["darwin", 1000, undefined, "Directory", 1000, undefined],
        ["win32", 1000, undefined, "Directory", 1000, undefined],
      ] as const) {
        const environment = { PATH: "/usr/bin", XDG_RUNTIME_DIR: runtimeDir };
        const result = yield* LocalDeviceHost.__testing.hubEnvironment(environment).pipe(
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.UserId, uid),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              stat: (path) => {
                expect(path).toBe("/run/user/1000");
                return Effect.succeed({ ...stat, type, uid: Option.some(owner) });
              },
            }),
          ),
        );
        expect(result.XDG_RUNTIME_DIR).toBe(expected);
        expect(result.PATH).toBe("/usr/bin");
        expect(result.FORCE_COLOR).toBe("0");
        expect(result.NO_COLOR).toBe("1");
        expect(environment.XDG_RUNTIME_DIR).toBe(runtimeDir);
      }
      const missing = yield* LocalDeviceHost.__testing
        .hubEnvironment({})
        .pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.UserId, 1000),
          Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
        );
      expect(missing.XDG_RUNTIME_DIR).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("limits hub discovery to Android unless the host is a Mac", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcess.Environment;
    const hubArguments = Effect.fn(function* (platform: NodeJS.Platform) {
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-hub-" });
      const installDir = path.join(baseDir, "tools/expo-device-hub", DEVICE_HUB_VERSION);
      const entryPath = path.join(installDir, "node_modules/expo-device-hub/dist/server/cli.mjs");
      const argumentsPath = path.join(baseDir, "hub-args.json");
      yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fs.writeFileString(path.join(installDir, ".install-complete"), DEVICE_HUB_VERSION);
      yield* fs.writeFileString(
        entryPath,
        `import http from 'node:http'; import fs from 'node:fs';
const args=process.argv.slice(2); fs.writeFileSync(${JSON.stringify(argumentsPath)},JSON.stringify(args));
http.createServer((req,res)=>res.end('ok')).listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1');`,
      );
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(baseDir, baseDir),
            NetService.layer,
            ProcessRunner.layer,
            FetchHttpClient.layer,
          ),
        ),
        Effect.provideService(HostProcess.Environment, { ...environment, HOME: baseDir }),
        Effect.provideService(HostProcess.Platform, platform),
      );
      yield* host.ensureReady(() => Effect.void).pipe(Effect.ensuring(host.stop));
      return (yield* fs
        .readFileString(argumentsPath)
        .pipe(Effect.map((contents) => JSON.parse(contents)))) as ReadonlyArray<string>;
    });
    expect((yield* hubArguments("linux")).slice(-2)).toEqual(["--platform", "android"]);
    expect(yield* hubArguments("darwin")).not.toContain("--platform");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "constructs and inspects an unconfigured host without installing or starting helpers",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-consent-" });
      const host = yield* LocalDeviceHost.make().pipe(
        Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
        Effect.provideService(HostProcess.Environment, { HOME: baseDir, PATH: "" }),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.die(new Error("Host construction must not spawn processes")),
          ),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Effect.die(new Error("Host construction must not run commands")),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.die(new Error("Host construction must not make network requests")),
          ),
        ),
      );
      expect(yield* host.current).toBeNull();
      const error = yield* host
        .ensureReady(() => Effect.die("Must not install without Node"))
        .pipe(Effect.flip, Effect.provideService(HostProcess.IsExecutable, true));
      expect(error.message).toContain("Local device support requires Node.js");
      expect(error.message).toContain("Install Node.js");
      yield* host.stop;
      expect(yield* fs.exists(`${baseDir}/tools`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { SshCommandError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;

describe("ssh tunnel scripts", () => {
  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it.effect.each([
    { operation: "launch", runner: "archive" },
    { operation: "launch", runner: "node" },
    { operation: "pairing", runner: "archive" },
    { operation: "pairing", runner: "node" },
  ] as const)("lets $runner $operation finish after a full lock wait", ({ operation, runner }) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          const result = operation === "launch" ? { remotePort: 3774 } : { credential: "test" };
          return {
            ...makeSuccessfulProcess(JSON.stringify(result)),
            exitCode: Deferred.await(finish).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
          };
        }),
      );
      const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
      const options = runner === "archive" ? ARCHIVE : { nodeScriptPath: "/test/server.js" };
      const command = Effect.gen(function* () {
        if (operation === "launch") {
          const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, options);
          assert.deepEqual(result, { remotePort: 3774, remoteServerKind: null });
        } else {
          const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, options);
          assert.deepEqual(result, { credential: "test" });
        }
      });
      const fiber = yield* command.pipe(
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(Duration.millis(900_001));
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                  Stream.concat(
                    Stream.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "stderr read failed",
                      }),
                    ),
                  ),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.

const LOCK_WAIT_SITE = '  if [ "$LOCK_WAIT_COUNT" -ge 9000 ]; then';
// Gives up after the first failed claim and recovery attempt instead of waiting.
const FAIL_FAST: readonly [string, string] = [
  LOCK_WAIT_SITE,
  '  if [ "$LOCK_WAIT_COUNT" -ge 0 ]; then',
];
const RECOVERY_SITE = '    if ln "$LAUNCH_LOCK_RECORD" "$RECLAIM_TARGET.reclaim" 2>/dev/null; then';
const HOLD_LOCK: readonly [string, string] = [
  "\nLAUNCH_LOCK_HELD=1\n",
  '\nLAUNCH_LOCK_HELD=1\nprintf "holding\\n"; read -r release\n',
];

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("launch script", () => {
  // Stands in for `t3 serve`: answers HTTP and writes its home's runtime file.
  const FAKE_SERVER = `process.title = "t3 (srv) test";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const baseDir = flag("--base-dir");
const server = http.createServer((_request, response) => response.end());
server.listen(Number(flag("--port")), "127.0.0.1", () => {
  const port = server.address().port;
  const userdata = path.join(baseDir, "userdata");
  fs.mkdirSync(userdata, { recursive: true });
  fs.writeFileSync(
    path.join(userdata, "server-runtime.json"),
    JSON.stringify({ version: 1, pid: process.pid, port, origin: "http://127.0.0.1:" + port }),
  );
});
`;

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const prepareLaunch = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launch-script-" });
    const home = `${root}/home`;
    const fakeServer = `${root}/fake-t3.cjs`;
    const launchScript = `${root}/launch.sh`;
    yield* fs.makeDirectory(home);
    yield* fs.writeFileString(fakeServer, FAKE_SERVER);
    yield* fs.writeFileString(
      launchScript,
      SshTunnel.buildRemoteLaunchScript({ nodeScriptPath: fakeServer }),
    );
    const stateDir = (stateKey: string) => `${home}/.t3/ssh-launch/${stateKey}`;
    const readManagedPid = (stateKey: string) =>
      fs.readFileString(`${stateDir(stateKey)}/pid`).pipe(Effect.map((pid) => Number(pid.trim())));
    // Launched servers outlive the script.
    const launchedPids = new Set<number>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const pid of launchedPids) {
          if (isAlive(pid)) process.kill(pid, "SIGKILL");
        }
      }),
    );
    const run = (
      stateKey: string,
      gate?: {
        readonly onLine: (line: string) => Effect.Effect<void>;
        readonly release: Effect.Effect<void>;
      },
      script = launchScript,
    ) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("sh", [script, stateKey], {
            ...(gate
              ? {
                  stdin: Stream.fromEffect(
                    gate.release.pipe(Effect.as(new TextEncoder().encode("go\n"))),
                  ),
                }
              : {}),
            env: { PATH: `${home}/bin:${process.env.PATH ?? ""}`, HOME: home },
            extendEnv: false,
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.tap((line) => gate?.onLine(line) ?? Effect.void),
              Stream.map((line) => `${line}\n`),
              Stream.mkString,
            ),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, exitCode };
      });
    const launch = (...args: Parameters<typeof run>) =>
      Effect.gen(function* () {
        const { stdout, stderr, exitCode } = yield* run(...args);
        assert.equal(exitCode, 0, stderr);
        const stateKey = args[0];
        const pid = yield* readManagedPid(stateKey).pipe(Effect.orElseSucceed(() => null));
        if (pid !== null) launchedPids.add(pid);
        return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as {
          remotePort: number;
          serverKind: string;
        };
      });
    const overrideProcessStart = (value: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(`${home}/bin`, { recursive: true });
        yield* fs.writeFileString(`${home}/bin/ps`, `#!/bin/sh\nprintf '%s\\n' '${value}'\n`);
        yield* fs.chmod(`${home}/bin/ps`, 0o700);
      });
    // Patches synchronization sites into a copy, so a missing site fails loudly.
    const writeVariant = (name: string, patches: ReadonlyArray<readonly [string, string]>) =>
      Effect.gen(function* () {
        let script = yield* fs.readFileString(launchScript);
        for (const [site, replacement] of patches) {
          assert.include(script, site, `launch script is missing the site ${site}`);
          script = script.replace(site, replacement);
        }
        const path = `${root}/${name}.sh`;
        yield* fs.writeFileString(path, script);
        return path;
      });
    const lockPath = `${home}/.t3/ssh-launch/.ownership.lock`;
    const exitedPid = Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", "exit 0"]));
      yield* child.exitCode;
      return child.pid;
    });
    return {
      fs,
      home,
      stateDir,
      readManagedPid,
      run,
      launch,
      writeVariant,
      lockPath,
      exitedPid,
      overrideProcessStart,
    };
  });

  it.live("keeps managing its server after the connection's state key changes", () =>
    Effect.gen(function* () {
      const { fs, stateDir, readManagedPid, launch } = yield* prepareLaunch;
      const launched = yield* launch("old-alias");
      assert.equal(launched.serverKind, "managed");
      const pid = yield* readManagedPid("old-alias");

      assert.deepEqual(yield* launch("new-alias"), launched);
      assert.equal(yield* readManagedPid("new-alias"), pid);
      assert.isFalse(yield* fs.exists(`${stateDir("old-alias")}/managed`));
      assert.isTrue(isAlive(pid));

      // A different runner under the next key is an update and replaces it.
      yield* fs.writeFileString(`${stateDir("new-alias")}/active-runner.sh`, "# previous runner\n");
      assert.equal((yield* launch("newer-alias")).serverKind, "managed");
      const replacementPid = yield* readManagedPid("newer-alias");
      assert.notEqual(replacementPid, pid);
      assert.isFalse(isAlive(pid));
      assert.isTrue(isAlive(replacementPid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("serializes two aliases claiming the same managed server", () =>
    Effect.gen(function* () {
      const { fs, stateDir, readManagedPid, launch, writeVariant } = yield* prepareLaunch;
      const launched = yield* launch("old-alias");
      const pid = yield* readManagedPid("old-alias");
      const firstAtTransfer = yield* Deferred.make<void>();
      const secondProgress = yield* Deferred.make<"waiting" | "transferring">();
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      // Report lock contention while the first transfer is held, so the race
      // does not depend on subprocess scheduling.
      const script = yield* writeVariant("contended", [
        [
          'if cmp -s "$PREVIOUS_STATE_DIR/active-runner.sh" "$RUNNER_FILE"; then',
          'printf "transferring\\n"; read -r release; if cmp -s "$PREVIOUS_STATE_DIR/active-runner.sh" "$RUNNER_FILE"; then',
        ],
        [LOCK_WAIT_SITE, '  printf "waiting\\n"; if [ "$LOCK_WAIT_COUNT" -ge 200 ]; then'],
      ]);
      const first = yield* launch(
        "first-alias",
        {
          onLine: (line) =>
            line === "transferring"
              ? Deferred.succeed(firstAtTransfer, undefined).pipe(Effect.asVoid)
              : Effect.void,
          release: Deferred.await(releaseFirst),
        },
        script,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(firstAtTransfer);
      const second = yield* launch(
        "second-alias",
        {
          onLine: (line) =>
            line === "waiting" || line === "transferring"
              ? Deferred.succeed(secondProgress, line).pipe(Effect.asVoid)
              : Effect.void,
          release: Deferred.await(releaseSecond),
        },
        script,
      ).pipe(Effect.forkScoped);
      assert.equal(yield* Deferred.await(secondProgress), "waiting");
      yield* Deferred.succeed(releaseFirst, undefined);
      assert.deepEqual(yield* Fiber.join(first), launched);
      yield* Deferred.succeed(releaseSecond, undefined);
      assert.deepEqual(yield* Fiber.join(second), launched);
      assert.equal(yield* readManagedPid("second-alias"), pid);
      assert.isFalse(yield* fs.exists(`${stateDir("first-alias")}/pid`));
      assert.isFalse(yield* fs.exists(`${stateDir("old-alias")}/pid`));
      assert.isTrue(isAlive(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not take over a server whose recorded process identity differs", () =>
    Effect.gen(function* () {
      const { fs, stateDir, readManagedPid, launch } = yield* prepareLaunch;
      const launched = yield* launch("old-alias");
      const pid = yield* readManagedPid("old-alias");
      // The recorded PID now belongs to some other process, as after PID reuse.
      yield* fs.writeFileString(`${stateDir("old-alias")}/process-start`, "a previous process\n");
      assert.deepEqual(yield* launch("new-alias"), {
        remotePort: launched.remotePort,
        serverKind: "external",
      });
      assert.isFalse(yield* fs.exists(`${stateDir("new-alias")}/pid`));
      assert.isTrue(isAlive(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each<{
    readonly owner: string;
    readonly lock: (exitedPid: number) => string;
    readonly killedRecovery?: boolean;
  }>([
    { owner: "a killed owner", lock: (exitedPid) => `${exitedPid}:linux:boot:1\n` },
    { owner: "a killed owner from an older release", lock: (exitedPid) => `${exitedPid}\n` },
    { owner: "an owner whose PID was reused", lock: () => `${process.pid}:a previous process\n` },
    {
      owner: "an owner from before a reboot",
      lock: () => `${process.pid}:linux:00000000-0000-0000-0000-000000000000:1\n`,
    },
    {
      owner: "a killed owner and a killed recovery",
      lock: (exitedPid) => `${exitedPid}\n`,
      killedRecovery: true,
    },
  ])("recovers the launch lock from $owner", ({ lock, killedRecovery }) =>
    Effect.gen(function* () {
      const { fs, launch, writeVariant, lockPath, exitedPid } = yield* prepareLaunch;
      const lockDir = lockPath.slice(0, lockPath.lastIndexOf("/"));
      const deadPid = yield* exitedPid;
      yield* fs.makeDirectory(lockDir, { recursive: true });
      yield* fs.writeFileString(lockPath, lock(deadPid));
      if (killedRecovery) yield* fs.writeFileString(`${lockPath}.reclaim`, `${deadPid}:\n`);
      const script = yield* writeVariant("fail-fast", [FAIL_FAST]);

      assert.equal((yield* launch("alias", undefined, script)).serverKind, "managed");
      const leftovers = (yield* fs.readDirectory(lockDir)).filter((name) =>
        name.startsWith(".ownership.lock"),
      );
      assert.deepEqual(leftovers, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leaves a live owner's launch lock in place", () =>
    Effect.gen(function* () {
      const { fs, run, launch, writeVariant, lockPath } = yield* prepareLaunch;
      const holding = yield* Deferred.make<void>();
      const releaseHolder = yield* Deferred.make<void>();
      const holder = yield* writeVariant("holder", [HOLD_LOCK]);
      const contender = yield* writeVariant("contender", [FAIL_FAST]);
      const first = yield* launch(
        "first-alias",
        {
          onLine: (line) =>
            line === "holding"
              ? Deferred.succeed(holding, undefined).pipe(Effect.asVoid)
              : Effect.void,
          release: Deferred.await(releaseHolder),
        },
        holder,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(holding);
      const owner = yield* fs.readFileString(lockPath);

      const second = yield* run("second-alias", undefined, contender);
      assert.equal(second.exitCode, 1);
      assert.include(second.stderr, "Another SSH operation holds");
      assert.equal(yield* fs.readFileString(lockPath), owner);
      yield* Deferred.succeed(releaseHolder, undefined);
      assert.equal((yield* Fiber.join(first)).serverKind, "managed");
      assert.isFalse(yield* fs.exists(lockPath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("waits past the former 20-second limit for a live owner to finish", () =>
    Effect.gen(function* () {
      const { launch, writeVariant } = yield* prepareLaunch;
      const holding = yield* Deferred.make<void>();
      const releaseHolder = yield* Deferred.make<void>();
      const holder = yield* writeVariant("slow-holder", [HOLD_LOCK]);
      const contender = yield* writeVariant("patient-contender", [
        ["LOCK_WAIT_COUNT=0", "LOCK_WAIT_COUNT=200"],
        ["  sleep 0.1", '  printf "waiting\\n"; read -r release'],
      ]);
      const first = yield* launch(
        "first-alias",
        {
          onLine: (line) =>
            line === "holding"
              ? Deferred.succeed(holding, undefined).pipe(Effect.asVoid)
              : Effect.void,
          release: Deferred.await(releaseHolder),
        },
        holder,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(holding);
      const second = yield* launch(
        "second-alias",
        {
          onLine: (line) =>
            line === "waiting"
              ? Deferred.succeed(releaseHolder, undefined).pipe(Effect.asVoid)
              : Effect.void,
          release: Fiber.join(first).pipe(Effect.orDie, Effect.asVoid),
        },
        contender,
      );
      assert.deepEqual(second, yield* Fiber.join(first));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not let a late recovery remove the next owner's launch lock", () =>
    Effect.gen(function* () {
      const { fs, run, launch, writeVariant, lockPath, exitedPid } = yield* prepareLaunch;
      yield* fs.makeDirectory(lockPath.slice(0, lockPath.lastIndexOf("/")), { recursive: true });
      yield* fs.writeFileString(lockPath, `${yield* exitedPid}\n`);
      const lateAtRecovery = yield* Deferred.make<void>();
      const releaseLate = yield* Deferred.make<void>();
      const holding = yield* Deferred.make<void>();
      const releaseHolder = yield* Deferred.make<void>();
      const late = yield* writeVariant("late-recovery", [
        FAIL_FAST,
        [RECOVERY_SITE, `    printf "recovering\\n"; read -r release\n${RECOVERY_SITE}`],
      ]);
      const holder = yield* writeVariant("holder", [HOLD_LOCK]);
      // The late contender has judged the killed owner stale and stops there.
      const lateRun = yield* run(
        "late-alias",
        {
          onLine: (line) =>
            line === "recovering"
              ? Deferred.succeed(lateAtRecovery, undefined).pipe(Effect.asVoid)
              : Effect.void,
          release: Deferred.await(releaseLate),
        },
        late,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(lateAtRecovery);
      // Another contender recovers the same stale lock and claims it.
      const next = yield* launch(
        "next-alias",
        {
          onLine: (line) =>
            line === "holding"
              ? Deferred.succeed(holding, undefined).pipe(Effect.asVoid)
              : Effect.void,
          release: Deferred.await(releaseHolder),
        },
        holder,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(holding);
      const owner = yield* fs.readFileString(lockPath);

      yield* Deferred.succeed(releaseLate, undefined);
      const lateResult = yield* Fiber.join(lateRun);
      assert.equal(lateResult.exitCode, 1, lateResult.stderr);
      assert.include(lateResult.stderr, "Another SSH operation holds");
      assert.equal(yield* fs.readFileString(lockPath), owner);
      yield* Deferred.succeed(releaseHolder, undefined);
      assert.equal((yield* Fiber.join(next)).serverKind, "managed");
      assert.isFalse(yield* fs.exists(lockPath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "does not remove the next reclaimer's marker when signalled after releasing its own",
    () =>
      Effect.gen(function* () {
        const { fs, home, run, launch, writeVariant, lockPath, exitedPid } = yield* prepareLaunch;
        const deadOwner = `${yield* exitedPid}\n`;
        yield* fs.makeDirectory(lockPath.slice(0, lockPath.lastIndexOf("/")), { recursive: true });
        yield* fs.writeFileString(lockPath, deadOwner);
        yield* fs.makeDirectory(`${home}/bin`, { recursive: true });
        // Interrupt only the first marker release, after unlink but before returning to sh.
        yield* fs.writeFileString(
          `${home}/bin/rm`,
          `#!/bin/sh
if [ "$1" = "-f" ] && [ "\${2:-}" = "$HOME/.t3/ssh-launch/.ownership.lock.reclaim" ] && mkdir "$HOME/removal-gated" 2>/dev/null; then
  /bin/rm "$@"
  printf 'marker-removed\\n'
  read -r release
  kill -TERM "$PPID"
else
  exec /bin/rm "$@"
fi
`,
        );
        yield* fs.chmod(`${home}/bin/rm`, 0o700);
        const markerRemoved = yield* Deferred.make<void>();
        const signalFirst = yield* Deferred.make<void>();
        const first = yield* run("first-alias", {
          onLine: (line) =>
            line === "marker-removed"
              ? Deferred.succeed(markerRemoved, undefined).pipe(Effect.asVoid)
              : Effect.void,
          release: Deferred.await(signalFirst),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(markerRemoved);

        yield* fs.writeFileString(lockPath, deadOwner);
        const nextChecked = yield* Deferred.make<void>();
        const releaseNext = yield* Deferred.make<void>();
        const nextScript = yield* writeVariant("rechecked", [
          [
            '        rm -f "$RECLAIM_TARGET"',
            '        printf "rechecked\\n"; read -r release; rm -f "$RECLAIM_TARGET"',
          ],
        ]);
        const next = yield* launch(
          "next-alias",
          {
            onLine: (line) =>
              line === "rechecked"
                ? Deferred.succeed(nextChecked, undefined).pipe(Effect.asVoid)
                : Effect.void,
            release: Deferred.await(releaseNext),
          },
          nextScript,
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(nextChecked);
        const nextMarker = yield* fs.readFileString(`${lockPath}.reclaim`);

        yield* Deferred.succeed(signalFirst, undefined);
        assert.equal((yield* Fiber.join(first)).exitCode, 143);
        assert.isTrue(
          yield* fs.exists(`${lockPath}.reclaim`),
          "signal cleanup removed the next reclaimer's marker",
        );
        assert.equal(yield* fs.readFileString(`${lockPath}.reclaim`), nextMarker);
        const contenderScript = yield* writeVariant("blocked", [FAIL_FAST]);
        const contender = yield* run("third-alias", undefined, contenderScript);
        assert.equal(contender.exitCode, 1, contender.stderr);
        assert.equal(yield* fs.readFileString(`${lockPath}.reclaim`), nextMarker);

        yield* Deferred.succeed(releaseNext, undefined);
        assert.equal((yield* Fiber.join(next)).serverKind, "managed");
        assert.isFalse(yield* fs.exists(lockPath));
        assert.isFalse(yield* fs.exists(`${lockPath}.reclaim`));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("Linux process identity", () => {
    it.live("keeps ownership when the wall-clock start time changes", () =>
      Effect.gen(function* () {
        const { fs, stateDir, readManagedPid, launch, overrideProcessStart } = yield* prepareLaunch;
        const launched = yield* launch("old-alias");
        const pid = yield* readManagedPid("old-alias");
        yield* overrideProcessStart("a corrected wall-clock start time");

        assert.deepEqual(yield* launch("new-alias"), launched);
        assert.equal(yield* readManagedPid("new-alias"), pid);
        const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
        const bootId = (yield* fs.readFileString("/proc/sys/kernel/random/boot_id")).trim();
        const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
        assert.equal(
          yield* fs.readFileString(`${stateDir("new-alias")}/process-start`),
          `linux:${bootId}:${startTicks}\n`,
        );
        assert.isTrue(isAlive(pid));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.live("migrates a matching legacy start time before transferring ownership", () =>
      Effect.gen(function* () {
        const { fs, stateDir, readManagedPid, launch, overrideProcessStart } = yield* prepareLaunch;
        const launched = yield* launch("old-alias");
        const pid = yield* readManagedPid("old-alias");
        const legacyStart = "Thu Oct  1 00:00:00 2026";
        yield* fs.writeFileString(`${stateDir("old-alias")}/process-start`, `${legacyStart}\n`);
        yield* overrideProcessStart(legacyStart);

        assert.deepEqual(yield* launch("new-alias"), launched);
        assert.equal(yield* readManagedPid("new-alias"), pid);
        assert.match(yield* fs.readFileString(`${stateDir("new-alias")}/process-start`), /^linux:/);
        assert.isFalse(yield* fs.exists(`${stateDir("old-alias")}/managed`));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });
});

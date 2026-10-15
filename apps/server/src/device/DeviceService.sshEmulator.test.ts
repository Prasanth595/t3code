// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - it.effect owns the test clock, so sshd startup has to wait on a real timer. The port reservation also uses node:net.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Net from "@t3tools/shared/Net";
import type { DeviceHostId, DevicePlatform } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeNet from "node:net";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";
import * as SshDeviceHost from "./SshDeviceHost.ts";

const reserveLoopbackPort = Effect.promise(
  () =>
    new Promise<number>((resolve, reject) => {
      const server = NodeNet.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close();
          reject(new Error("Could not reserve a loopback port."));
          return;
        }
        const { port } = address;
        server.close((error) => (error ? reject(error) : resolve(port)));
      });
    }),
);

const commandText = (command: ChildProcess.Command) =>
  command._tag === "StandardCommand" ? command.args.join(" ") : "";

it.effect(
  "keeps iOS and physical Android devices when the real SSH adapter cannot find the emulator",
  () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-ssh-" });
      const home = `${directory}/home`;
      const log = `${directory}/sshd.log`;
      const knownHosts = `${directory}/known_hosts`;
      yield* fs.makeDirectory(home);
      yield* fs.makeDirectory(`${directory}/bin`);
      const port = yield* reserveLoopbackPort;
      yield* real.exitCode(
        ChildProcess.make("/usr/bin/ssh-keygen", [
          "-q",
          "-t",
          "ed25519",
          "-f",
          `${directory}/host`,
          "-N",
          "",
        ]),
      );
      yield* real.exitCode(
        ChildProcess.make("/usr/bin/ssh-keygen", [
          "-q",
          "-t",
          "ed25519",
          "-f",
          `${directory}/user`,
          "-N",
          "",
        ]),
      );
      yield* fs.writeFileString(
        `${directory}/sshd_config`,
        [
          `Port ${port}`,
          "ListenAddress 127.0.0.1",
          "AddressFamily inet",
          `HostKey ${directory}/host`,
          `PidFile ${directory}/sshd.pid`,
          `AuthorizedKeysFile ${directory}/user.pub`,
          "PasswordAuthentication no",
          "KbdInteractiveAuthentication no",
          "UsePAM no",
          "PermitRootLogin no",
          "StrictModes no",
          `SetEnv HOME=${home} PATH=/usr/bin:/bin`,
          "",
        ].join("\n"),
      );
      // -F skips /etc/ssh/ssh_config. In the review sandbox's user namespace those
      // root-owned includes fail OpenSSH's owner check before any authentication.
      yield* fs.writeFileString(`${directory}/ssh_config`, "Host *\n");
      yield* fs.writeFileString(
        `${directory}/bin/ssh`,
        `#!/bin/sh
exec /usr/bin/ssh \\
  -F "$T3_DEVICE_SSH_CONFIG" \\
  -o BatchMode=yes \\
  -o StrictHostKeyChecking=yes \\
  -o UserKnownHostsFile="$T3_DEVICE_SSH_KNOWN_HOSTS" \\
  -o GlobalKnownHostsFile=/dev/null \\
  -o IdentitiesOnly=yes \\
  "$@"
`,
      );
      yield* fs.chmod(`${directory}/bin/ssh`, 0o755);
      const sshd = yield* real.spawn(
        ChildProcess.make("/usr/bin/sshd", ["-f", `${directory}/sshd_config`, "-D", "-E", log], {
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      yield* Effect.addFinalizer(() => sshd.kill().pipe(Effect.ignore));
      let listening = false;
      let sshdLog = "";
      for (let attempt = 0; attempt < 50 && !listening; attempt++) {
        sshdLog = yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => ""));
        if (sshdLog.includes("Server listening")) {
          listening = true;
          break;
        }
        // it.effect uses the test clock, so this wait has to be a real timer.
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));
      }
      if (!listening) return yield* Effect.die(new Error(`sshd did not listen.\n${sshdLog}`));
      const scanned = yield* Effect.promise(async () => {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFile);
        return exec("/usr/bin/ssh-keyscan", ["-4", "-T", "2", "-p", String(port), "127.0.0.1"], {
          timeout: 5000,
        });
      }).pipe(Effect.map((result) => result.stdout));
      if (!scanned.includes("ssh-ed25519")) {
        return yield* Effect.die(new Error(`ssh-keyscan did not return a host key.\n${scanned}`));
      }
      yield* fs.writeFileString(knownHosts, scanned);
      const previousPath = process.env.PATH;
      const previousKnownHosts = process.env.T3_DEVICE_SSH_KNOWN_HOSTS;
      const previousConfig = process.env.T3_DEVICE_SSH_CONFIG;
      process.env.PATH = `${directory}/bin:${previousPath ?? ""}`;
      process.env.T3_DEVICE_SSH_KNOWN_HOSTS = knownHosts;
      process.env.T3_DEVICE_SSH_CONFIG = `${directory}/ssh_config`;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousPath === undefined) delete process.env.PATH;
          else process.env.PATH = previousPath;
          if (previousKnownHosts === undefined) delete process.env.T3_DEVICE_SSH_KNOWN_HOSTS;
          else process.env.T3_DEVICE_SSH_KNOWN_HOSTS = previousKnownHosts;
          if (previousConfig === undefined) delete process.env.T3_DEVICE_SSH_CONFIG;
          else process.env.T3_DEVICE_SSH_CONFIG = previousConfig;
        }),
      );

      let realSshCommands = 0;
      const spawner = ChildProcessSpawner.make((command) => {
        if (commandText(command).includes("-list-avds")) {
          realSshCommands += 1;
          return real.spawn(command);
        }
        if (command._tag === "StandardCommand" && command.args.includes("-N")) {
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(41),
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
          );
        }
        const output = JSON.stringify({
          nodePath: "/usr/bin/node",
          platforms: [
            { platform: "ios", available: true },
            { platform: "android", available: true },
          ],
          hubPort: 1,
          helpers: { serveSimAxSettings: null, serveSimCli: null },
        });
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(42),
            stdout: Stream.make(new TextEncoder().encode(output)),
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        );
      });
      const hostId = "isolated-ssh" as DeviceHostId;
      const sshHost = yield* SshDeviceHost.make({
        id: hostId,
        label: "Isolated SSH",
        target: "127.0.0.1",
        port,
        identityFile: `${directory}/user`,
      }).pipe(
        Effect.provide(Layer.mergeAll(ServerConfig.layerTest(directory, directory), Net.layer)),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
          ),
        ),
      );
      yield* Effect.addFinalizer(() => sshHost.stop.pipe(Effect.ignore));
      yield* sshHost.ensureReady(() => Effect.void);
      const ready = yield* sshHost.current;
      if (!ready) return yield* Effect.die(new Error("SSH host did not become ready."));

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          if (path !== "/api/devices") throw new Error(`Unexpected hub path: ${path}`);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              simulators: [
                {
                  id: "11111111-1111-1111-1111-111111111111",
                  name: "iPhone 16",
                  platform: "ios",
                  version: "26",
                  booted: true,
                  physical: false,
                },
              ],
              emulators: [
                {
                  id: "R3CW10ABC",
                  name: "Pixel 8",
                  platform: "android",
                  version: "Android 15",
                  booted: false,
                  physical: true,
                },
              ],
              errors: [{ message: "Android SDK command-line tools are missing." }],
            }),
          );
        }),
      );
      const service = yield* DeviceService.makeWithHosts(
        new Map([
          [
            hostId,
            {
              id: hostId,
              summary: Effect.succeed({
                id: hostId,
                kind: "ssh" as const,
                label: "Isolated SSH",
                platforms: [
                  { platform: "ios" as const, available: true },
                  { platform: "android" as const, available: true },
                ],
                hubInstalled: true,
                agentDeviceInstalled: false,
              }),
              platformAvailability: (platform: DevicePlatform) =>
                Effect.succeed({ platform, available: true }),
              ensureReady: () =>
                Effect.succeed({
                  ...ready,
                  hub: { origin: "http://device.test" },
                }),
              ensureAgentReady: () => Effect.die(new Error("Agent access is not used.")),
              current: Effect.succeed(null),
              stopAgent: Effect.void,
              stop: Effect.void,
            } satisfies DeviceHost.DeviceHost["Service"],
          ],
        ]),
      ).pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })),
      );
      const before = yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => ""));
      const state = yield* service.list;
      const after = yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => ""));
      expect(realSshCommands).toBe(1);
      expect(after.slice(before.length)).toContain("Accepted publickey");
      expect(state.devices).toEqual([
        {
          hostId,
          id: "11111111-1111-1111-1111-111111111111",
          platform: "ios",
          name: "iPhone 16",
          version: "26",
          booted: true,
          physical: false,
        },
        {
          hostId,
          id: "R3CW10ABC",
          platform: "android",
          name: "Pixel 8",
          version: "Android 15",
          booted: false,
          physical: true,
        },
      ]);
      const detail = state.hostStatuses[hostId]?.detail ?? "";
      expect(state.hostStatuses[hostId]?.status).toBe("ready");
      expect(detail.startsWith("Android SDK command-line tools are missing.\n")).toBe(true);
      expect(detail).toContain(
        "Android Emulator is not installed, so virtual devices cannot be listed.",
      );
      expect(detail).toContain("emulator: not found");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// @effect-diagnostics nodeBuiltinImport:off - binds a free loopback port before sshd starts.
// OpenSSH plus bubblewrap integration. CI installs both. bubblewrap hides the host
// /usr/local and /opt trees so the adapter's added PATH entries cannot see an emulator.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Net from "@t3tools/shared/Net";
import type { DeviceHostId, DevicePlatform } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
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

const executable = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const directory of [
      ...(process.env.PATH ?? "").split(":"),
      "/usr/local/sbin",
      "/usr/sbin",
      "/usr/bin",
      "/bin",
      "/opt/homebrew/sbin",
      "/opt/homebrew/bin",
    ]) {
      if (!directory) continue;
      const candidate = path.join(directory, name);
      if (yield* fs.exists(candidate)) return candidate;
    }
    return yield* Effect.die(
      new Error(
        `${name} is required for the device SSH integration test. Install OpenSSH server and bubblewrap.`,
      ),
    );
  });

const commandText = (command: ChildProcess.Command) =>
  command._tag === "StandardCommand" ? command.args.join(" ") : "";

const idleHandle = (input: {
  readonly stdout?: Stream.Stream<Uint8Array>;
  readonly exitCode: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly running: boolean;
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    stdout: input.stdout ?? Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: input.exitCode,
    isRunning: Effect.succeed(input.running),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

it.live(
  "keeps iOS and physical Android devices when the real SSH adapter cannot find the emulator",
  () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      const [sshd, ssh, sshKeygen, sshKeyscan, bwrap] = yield* Effect.all(
        [
          executable("sshd"),
          executable("ssh"),
          executable("ssh-keygen"),
          executable("ssh-keyscan"),
          executable("bwrap"),
        ],
        { concurrency: 1 },
      );
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-ssh-" });
      const home = `${directory}/home`;
      const knownHosts = `${directory}/known_hosts`;
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.makeDirectory(`${directory}/bin`);
      const port = yield* reserveLoopbackPort;
      for (const name of ["host", "user"]) {
        const code = yield* real.exitCode(
          ChildProcess.make(sshKeygen, [
            "-q",
            "-t",
            "ed25519",
            "-f",
            `${directory}/${name}`,
            "-N",
            "",
          ]),
        );
        if (Number(code) !== 0)
          return yield* Effect.die(new Error(`ssh-keygen ${name} exited ${Number(code)}`));
      }
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
      // -F skips /etc/ssh/ssh_config. The review sandbox's user namespace makes those
      // root-owned includes fail OpenSSH's owner check before authentication.
      yield* fs.writeFileString(`${directory}/ssh_config`, "Host *\n");
      yield* fs.writeFileString(
        `${directory}/bin/ssh`,
        `#!/bin/sh
exec ${ssh.includes(" ") ? `'${ssh.replaceAll("'", "'\"'\"'")}'` : ssh} \\
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
      const sshdLogs = yield* Ref.make("");
      const listening = yield* Deferred.make<void>();
      const sshdProcess = yield* real.spawn(
        ChildProcess.make(
          bwrap,
          [
            "--die-with-parent",
            "--dev-bind",
            "/",
            "/",
            "--tmpfs",
            "/usr/local",
            "--tmpfs",
            "/opt",
            "--",
            sshd,
            "-e",
            "-D",
            "-f",
            `${directory}/sshd_config`,
          ],
          { stdout: "ignore", stderr: "pipe" },
        ),
      );
      yield* Effect.addFinalizer(() => sshdProcess.kill().pipe(Effect.ignore));
      yield* sshdProcess.stderr.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.gen(function* () {
            yield* Ref.update(sshdLogs, (current) => `${current}${line}\n`);
            if (line.includes("Server listening")) {
              yield* Deferred.succeed(listening, undefined).pipe(Effect.ignore);
            }
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(listening).pipe(
        Effect.timeout("5 seconds"),
        Effect.catch((error) =>
          Ref.get(sshdLogs).pipe(
            Effect.flatMap((text) =>
              Effect.die(new Error(`sshd did not listen: ${String(error)}\n${text}`)),
            ),
          ),
        ),
      );
      const scanned = yield* real
        .string(ChildProcess.make(sshKeyscan, ["-4", "-T", "2", "-p", String(port), "127.0.0.1"]))
        .pipe(Effect.timeout("5 seconds"));
      if (!scanned.includes("ssh-ed25519")) {
        return yield* Effect.die(new Error(`ssh-keyscan did not return a host key.\n${scanned}`));
      }
      yield* fs.writeFileString(knownHosts, scanned);
      const previous = {
        PATH: process.env.PATH,
        knownHosts: process.env.T3_DEVICE_SSH_KNOWN_HOSTS,
        config: process.env.T3_DEVICE_SSH_CONFIG,
      };
      process.env.PATH = `${directory}/bin:${previous.PATH ?? ""}`;
      process.env.T3_DEVICE_SSH_KNOWN_HOSTS = knownHosts;
      process.env.T3_DEVICE_SSH_CONFIG = `${directory}/ssh_config`;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          const restore = (
            name: "PATH" | "T3_DEVICE_SSH_KNOWN_HOSTS" | "T3_DEVICE_SSH_CONFIG",
            value: string | undefined,
          ) => {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          };
          restore("PATH", previous.PATH);
          restore("T3_DEVICE_SSH_KNOWN_HOSTS", previous.knownHosts);
          restore("T3_DEVICE_SSH_CONFIG", previous.config);
        }),
      );

      let realSshCommands = 0;
      const spawner = ChildProcessSpawner.make((command) => {
        const text = commandText(command);
        if (!text.includes("-N") && !text.includes("exec node")) {
          realSshCommands += 1;
          return real.spawn(command);
        }
        if (text.includes("-N")) {
          return Effect.succeed(idleHandle({ exitCode: Effect.never, running: true }));
        }
        return Effect.succeed(
          idleHandle({
            stdout: Stream.make(
              new TextEncoder().encode(
                JSON.stringify({
                  nodePath: "/usr/bin/node",
                  platforms: [
                    { platform: "ios", available: true },
                    { platform: "android", available: true },
                  ],
                  hubPort: 1,
                  helpers: { serveSimAxSettings: null, serveSimCli: null },
                }),
              ),
            ),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            running: false,
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
        Effect.sync(() =>
          HttpClientResponse.fromWeb(
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
          ),
        ),
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
                Effect.succeed({ ...ready, hub: { origin: "http://device.test" } }),
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
      const state = yield* service.list;
      const pathProbe = yield* ready.run("sh", [
        "-c",
        "command -v emulator >/dev/null 2>&1 && echo FOUND || echo ABSENT; printf '%s\\n' \"$PATH\"",
      ]);
      const sshdText = yield* Ref.get(sshdLogs);
      expect(realSshCommands).toBe(2);
      expect(sshdText).toContain("Accepted publickey");
      expect(state.hostStatuses[hostId]?.status).toBe("ready");
      expect(state.devices.map((device) => [device.platform, device.id, device.physical])).toEqual([
        ["ios", "11111111-1111-1111-1111-111111111111", false],
        ["android", "R3CW10ABC", true],
      ]);
      const detail = state.hostStatuses[hostId]?.detail ?? "";
      expect(detail.startsWith("Android SDK command-line tools are missing.\n")).toBe(true);
      expect(detail).toContain(
        "Android Emulator is not installed, so virtual devices cannot be listed.",
      );
      expect(detail).toContain("emulator: not found");
      expect(pathProbe.code).toBe(0);
      expect(pathProbe.stdout).toContain("ABSENT");
      expect(pathProbe.stdout).not.toContain("FOUND");
      expect(pathProbe.stdout).toContain("/usr/local/bin");
      expect(pathProbe.stdout).toContain("/opt/homebrew/bin");
      expect(pathProbe.stdout).toContain(".local/bin");
    }).pipe(Effect.provide(NodeServices.layer)),
);

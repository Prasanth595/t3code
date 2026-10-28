import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { SshPasswordPromptError } from "./errors.ts";
import * as SshPortForward from "./portForward.ts";

const makeRunningProcess = (onKill?: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return {
    handle: ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(456),
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
          onKill?.();
          finish?.(ChildProcessSpawner.ExitCode(143));
        }),
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    }),
    finish: (exitCode = 0) => finish?.(ChildProcessSpawner.ExitCode(exitCode)),
  };
};

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

const makeFailingProcess = (stderr: string, exitCode = 255) => {
  const stderrStream = Stream.make(new TextEncoder().encode(stderr));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: stderrStream,
    all: stderrStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

describe("ssh port forward manager", () => {
  const target = {
    alias: "devbox",
    hostname: "devbox.internal",
    username: "developer",
    port: 22,
  };

  const createNetService = (activeListeners: Set<number>) =>
    NetService.NetService.of({
      canListenOnHost: (port) => Effect.succeed(!activeListeners.has(port)),
      isPortAvailableOnLoopback: (port) => Effect.succeed(!activeListeners.has(port)),
      hasListenerOnHost: (port) => Effect.succeed(activeListeners.has(port)),
      reserveLoopbackPort: () => Effect.succeed(50000),
      findAvailablePort: (preferred) => Effect.succeed(preferred > 0 ? preferred : 50000),
    });

  it.effect("forwards a remote port to matching local port with loopback binding", () =>
    Effect.gen(function* () {
      let killed = false;
      const spawnedCommands: string[][] = [];
      const activeListeners = new Set<number>();

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = [...commandArgs(command)];
          spawnedCommands.push(args);
          if (args.includes("-G")) {
            return makeSuccessfulProcess(
              "hostname devbox.internal\nuser developer\nport 22\n",
            );
          }
          activeListeners.add(3000);
          return makeRunningProcess(() => {
            killed = true;
            activeListeners.delete(3000);
          }).handle;
        }),
      );

      const testLayer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(NetService.NetService, createNetService(activeListeners)),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshPortForward.layer,
      );

      yield* Effect.gen(function* () {
        const manager = yield* SshPortForward.SshPortForwardManager;
        const forward = yield* manager.forwardPort(target, 3000);

        assert.equal(forward.remotePort, 3000);
        assert.equal(forward.localPort, 3000);
        assert.equal(forward.localUrl, "http://127.0.0.1:3000");
        assert.equal(forward.status, "active");

        // Verify SSH forward command arguments use 127.0.0.1:localPort:127.0.0.1:remotePort
        const forwardCmd = spawnedCommands.find((c) => c.includes("-L"));
        assert.isDefined(forwardCmd);
        assert.isTrue(forwardCmd?.includes("127.0.0.1:3000:127.0.0.1:3000"));
        assert.isTrue(forwardCmd?.includes("ExitOnForwardFailure=yes"));

        // List forwards
        const list = yield* manager.listForwardedPorts(target);
        assert.equal(list.length, 1);
        assert.equal(list[0]?.remotePort, 3000);

        // Unforward
        const unforwarded = yield* manager.unforwardPort(target, 3000);
        assert.isTrue(unforwarded);
        assert.isTrue(killed);

        const emptyList = yield* manager.listForwardedPorts(target);
        assert.equal(emptyList.length, 0);
      }).pipe(Effect.provide(testLayer), Effect.scoped);
    }),
  );

  it.effect("monitors process exit and removes dead forwards during lifetime", () =>
    Effect.gen(function* () {
      let processControls: ReturnType<typeof makeRunningProcess> | null = null;
      const activeListeners = new Set<number>();

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = [...commandArgs(command)];
          if (args.includes("-G")) {
            return makeSuccessfulProcess(
              "hostname devbox.internal\nuser developer\nport 22\n",
            );
          }
          activeListeners.add(4000);
          processControls = makeRunningProcess(() => {
            activeListeners.delete(4000);
          });
          return processControls.handle;
        }),
      );

      const testLayer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(NetService.NetService, createNetService(activeListeners)),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshPortForward.layer,
      );

      yield* Effect.gen(function* () {
        const manager = yield* SshPortForward.SshPortForwardManager;
        yield* manager.forwardPort(target, 4000);

        const listBefore = yield* manager.listForwardedPorts(target);
        assert.equal(listBefore.length, 1);

        // Tunnel process exits unexpectedly later during its lifetime
        processControls?.finish(255);
        yield* Effect.yieldNow();

        const listAfter = yield* manager.listForwardedPorts(target);
        assert.equal(listAfter.length, 0);
      }).pipe(Effect.provide(testLayer), Effect.scoped);
    }),
  );

  it.effect("serializes concurrent forwardPort calls for the same target and port", () =>
    Effect.gen(function* () {
      let tunnelSpawnCount = 0;
      const activeListeners = new Set<number>();

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = [...commandArgs(command)];
          if (args.includes("-G")) {
            return makeSuccessfulProcess(
              "hostname devbox.internal\nuser developer\nport 22\n",
            );
          }
          tunnelSpawnCount += 1;
          activeListeners.add(5000);
          return makeRunningProcess(() => {
            activeListeners.delete(5000);
          }).handle;
        }),
      );

      const testLayer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(NetService.NetService, createNetService(activeListeners)),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshPortForward.layer,
      );

      yield* Effect.gen(function* () {
        const manager = yield* SshPortForward.SshPortForwardManager;
        // Two concurrent calls for the same target and port
        const [first, second] = yield* Effect.all(
          [manager.forwardPort(target, 5000), manager.forwardPort(target, 5000)],
          { concurrency: 2 },
        );

        assert.equal(first.remotePort, 5000);
        assert.equal(second.remotePort, 5000);
        assert.equal(tunnelSpawnCount, 1); // Only spawned once
      }).pipe(Effect.provide(testLayer), Effect.scoped);
    }),
  );

  it.effect("handles password authentication prompt on auth failure and retries", () =>
    Effect.gen(function* () {
      let attemptCount = 0;
      let promptRequested = false;
      const activeListeners = new Set<number>();

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = [...commandArgs(command)];
          if (args.includes("-G")) {
            return makeSuccessfulProcess(
              "hostname devbox.internal\nuser developer\nport 22\n",
            );
          }
          attemptCount += 1;
          if (attemptCount === 1) {
            // First attempt fails with permission denied
            return makeFailingProcess(
              "Permission denied (publickey,password).\n",
              255,
            );
          }
          // Second attempt succeeds after password prompt
          activeListeners.add(8080);
          return makeRunningProcess(() => {
            activeListeners.delete(8080);
          }).handle;
        }),
      );

      const mockPromptLayer = Layer.succeed(
        SshAuth.SshPasswordPrompt,
        SshAuth.SshPasswordPrompt.of({
          isAvailable: true,
          request: () =>
            Effect.sync(() => {
              promptRequested = true;
              return "secret-password";
            }),
        }),
      );

      const testLayer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(NetService.NetService, createNetService(activeListeners)),
        mockPromptLayer,
        SshPortForward.layer,
      );

      yield* Effect.gen(function* () {
        const manager = yield* SshPortForward.SshPortForwardManager;
        const forward = yield* manager.forwardPort(target, 8080);

        assert.equal(forward.remotePort, 8080);
        assert.isTrue(promptRequested);
        assert.equal(attemptCount, 2);
      }).pipe(Effect.provide(testLayer), Effect.scoped);
    }),
  );

  it.effect("syncAutoPortForwards adds new ports and removes closed ones", () =>
    Effect.gen(function* () {
      let killCount = 0;
      const activeListeners = new Set<number>();

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = [...commandArgs(command)];
          if (args.includes("-G")) {
            return makeSuccessfulProcess(
              "hostname devbox.internal\nuser developer\nport 22\n",
            );
          }
          const portMatch = args.find((a) => a.startsWith("127.0.0.1:") && a.includes(":127.0.0.1:"));
          const localPort = portMatch ? Number(portMatch.split(":")[1]) : 3000;
          activeListeners.add(localPort);
          return makeRunningProcess(() => {
            killCount += 1;
            activeListeners.delete(localPort);
          }).handle;
        }),
      );

      const testLayer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(NetService.NetService, createNetService(activeListeners)),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshPortForward.layer,
      );

      yield* Effect.gen(function* () {
        const manager = yield* SshPortForward.SshPortForwardManager;

        // Remote reports ports 3000 and 8080 listening (and 3773 is t3 server to exclude)
        const syncResult1 = yield* manager.syncAutoPortForwards(
          target,
          [3000, 8080, 3773],
          [3773],
        );

        assert.deepEqual(syncResult1.forwarded, [3000, 8080]);
        assert.deepEqual(syncResult1.unforwarded, []);
        assert.equal(syncResult1.activeForwards.length, 2);

        // Remote now only has 8080 and new 5173 (3000 stopped)
        const syncResult2 = yield* manager.syncAutoPortForwards(
          target,
          [8080, 5173],
          [3773],
        );

        assert.deepEqual(syncResult2.forwarded, [5173]);
        assert.deepEqual(syncResult2.unforwarded, [3000]);
        assert.equal(syncResult2.activeForwards.length, 2);
        assert.isTrue(killCount >= 1); // Port 3000 was killed

        // Close all for target
        yield* manager.closeAllForTarget(target);
        const finalList = yield* manager.listForwardedPorts(target);
        assert.equal(finalList.length, 0);
      }).pipe(Effect.provide(testLayer), Effect.scoped);
    }),
  );

  it.effect("syncAutoPortForwards aborts remaining ports if password authentication fails", () =>
    Effect.gen(function* () {
      let tunnelSpawnCount = 0;
      const activeListeners = new Set<number>();

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = [...commandArgs(command)];
          if (args.includes("-G")) {
            return makeSuccessfulProcess(
              "hostname devbox.internal\nuser developer\nport 22\n",
            );
          }
          tunnelSpawnCount += 1;
          return makeFailingProcess("Permission denied (publickey,password).\n", 255);
        }),
      );

      const mockPromptLayer = Layer.succeed(
        SshAuth.SshPasswordPrompt,
        SshAuth.SshPasswordPrompt.of({
          isAvailable: true,
          request: () =>
            Effect.fail(
              new SshPasswordPromptError({
                message: "Authentication was canceled",
              }),
            ),
        }),
      );

      const testLayer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(NetService.NetService, createNetService(activeListeners)),
        mockPromptLayer,
        SshPortForward.layer,
      );

      yield* Effect.gen(function* () {
        const manager = yield* SshPortForward.SshPortForwardManager;
        const result = yield* manager.syncAutoPortForwards(target, [3000, 3001, 3002]);

        // Loop should abort immediately after first port fails with SshPasswordPromptError
        assert.equal(tunnelSpawnCount, 1);
        assert.deepEqual(result.forwarded, []);
      }).pipe(Effect.provide(testLayer), Effect.scoped);
    }),
  );
});

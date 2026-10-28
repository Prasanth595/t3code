import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import * as SshPortForward from "./portForward.ts";

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
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
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
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

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(50000),
  findAvailablePort: (preferred) => Effect.succeed(preferred > 0 ? preferred : 50000),
});

describe("ssh port forward manager", () => {
  const target = {
    alias: "devbox",
    hostname: "devbox.internal",
    username: "developer",
    port: 22,
  };

  it.effect("forwards a remote port to matching local port when available", () =>
    Effect.gen(function* () {
      let killed = false;
      const spawnedCommands: string[][] = [];

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = [...commandArgs(command)];
          spawnedCommands.push(args);
          if (args.includes("-G")) {
            return makeSuccessfulProcess(
              "hostname devbox.internal\nuser developer\nport 22\n",
            );
          }
          return makeRunningProcess(() => {
            killed = true;
          });
        }),
      );

      const testLayer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(NetService.NetService, testNetService),
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

        // Verify SSH forward command arguments
        const forwardCmd = spawnedCommands.find((c) => c.includes("-L"));
        assert.isDefined(forwardCmd);
        assert.isTrue(forwardCmd?.includes("3000:127.0.0.1:3000"));
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

  it.effect("syncAutoPortForwards adds new ports and removes closed ones", () =>
    Effect.gen(function* () {
      let killCount = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const args = [...commandArgs(command)];
          if (args.includes("-G")) {
            return makeSuccessfulProcess(
              "hostname devbox.internal\nuser developer\nport 22\n",
            );
          }
          return makeRunningProcess(() => {
            killCount += 1;
          });
        }),
      );

      const testLayer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(NetService.NetService, testNetService),
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
});

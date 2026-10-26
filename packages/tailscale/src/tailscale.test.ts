import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  claimTailscaleServe,
  ensureTailscaleServe,
  parseTailscaleExitNode,
  parseTailscaleSshEnabled,
  parseTailscaleStatus,
  readTailscaleSshEnabled,
  readTailscaleStatus,
  releaseTailscaleServe,
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleStatusParseError,
} from "./tailscale.ts";

const encoder = new TextEncoder();

function assertCarriesNoSecret(error: object, secret: string): void {
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      assert.notInclude(value, secret, `${path} leaked stderr`);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
      return;
    }
    // `message` and `cause` are getters on Error subclasses, so they are not
    // own enumerable properties and Object.entries alone would skip them.
    walk((value as { message?: unknown }).message, `${path}.message`);
    walk((value as { cause?: unknown }).cause, `${path}.cause`);
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, `${path}.${key}`);
    }
  };

  walk(error, "error");
}
const tailscaleStatusJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20"]}}`;

function mockHandle(result: { stdout?: string; stderr?: string; code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

// The executable name depends on the host platform (`tailscale.exe` on
// Windows), so pin it: these tests assert the posix spelling.
function layerSpawner(spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) {
  return Layer.merge(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HostProcess.Platform, "linux"),
  );
}

function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number },
) {
  return layerSpawner(
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

function layerServeFixture(
  rootProxy: string | null,
  listener: object = { HTTPS: true },
  extra: object = {},
) {
  const writes: Array<ReadonlyArray<string>> = [];
  const serveStatus = JSON.stringify({
    ...extra,
    TCP: { "443": listener },
    Web: {
      "desktop.tail.ts.net:443": {
        Handlers: {
          ...(rootProxy === null ? {} : { "/": { Proxy: rootProxy } }),
          "/keep/": { Proxy: "http://127.0.0.1:8081" },
        },
      },
    },
  });
  const layer = layerMockSpawner((_command, args) => {
    if (args.join(" ") === "serve status --json") {
      return { stdout: serveStatus };
    }
    writes.push(args);
    return {};
  });
  return { layer, writes };
}

/** A loopback port with a listener for the rest of the scope. */
const listenOnLoopback = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.map((server) => {
    const address = server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }),
);

describe("tailscale", () => {
  it.effect("parses status facts", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleStatus(tailscaleStatusJson);
      assert.deepEqual(status, {
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.100.100.100"],
        httpsServeEnabled: null,
      });
    }),
  );

  it.effect("names the exit node in use", () =>
    Effect.gen(function* () {
      const inUse = yield* parseTailscaleExitNode(
        JSON.stringify({
          ExitNodeStatus: { ID: "nX", Online: true, TailscaleIPs: ["100.101.102.103/32"] },
          Peer: {
            "nodekey:a": { HostName: "laptop", DNSName: "laptop.tail.ts.net.", ExitNode: false },
            "nodekey:b": {
              HostName: "raspberrypi",
              DNSName: "home-pi.tail.ts.net.",
              ExitNode: true,
            },
          },
        }),
      );
      assert.deepEqual(inUse, { name: "home-pi", online: true });

      const unnamed = yield* parseTailscaleExitNode(`{"ExitNodeStatus":{"Online":false}}`);
      assert.deepEqual(unnamed, { name: null, online: false });

      assert.equal(yield* parseTailscaleExitNode(tailscaleStatusJson), null);
    }),
  );

  it.effect("reads the HTTPS serve capability from the status capability map", () =>
    Effect.gen(function* () {
      const enabled = yield* parseTailscaleStatus(
        `{"Self":{"CapMap":{"https":null,"funnel":null}}}`,
      );
      assert.equal(enabled.httpsServeEnabled, true);

      const disabled = yield* parseTailscaleStatus(`{"Self":{"CapMap":{"funnel":null}}}`);
      assert.equal(disabled.httpsServeEnabled, false);
    }),
  );

  it.effect("reads Tailscale SSH enablement from local prefs", () => {
    const prefsJson =
      '{\n\t"ControlURL": "https://controlplane.tailscale.com",\n\t"RunSSH": true,\n\t"WantRunning": true\n}\n';
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["debug", "prefs"]);
      return { stdout: prefsJson };
    });

    return Effect.gen(function* () {
      assert.isTrue(yield* readTailscaleSshEnabled.pipe(Effect.provide(layer)));
      assert.isFalse(yield* parseTailscaleSshEnabled('{"RunSSH":false,"WantRunning":true}'));
      assert.isFalse(yield* parseTailscaleSshEnabled('{"RunSSH":true,"WantRunning":false}'));
      assert.isFalse(yield* parseTailscaleSshEnabled("{}"));
      const error = yield* parseTailscaleSshEnabled("{not-json").pipe(Effect.flip);
      assert.instanceOf(error, TailscaleStatusParseError);
    });
  });

  it.effect("turns spawn defects into typed spawn failures", () => {
    // A non-directory entry on PATH makes node's spawn throw ENOTDIR
    // synchronously. The platform spawner calls `NodeChildProcess.spawn` from
    // inside an `Effect.callback` registration, so that throw arrives as a
    // defect rather than a typed error - the shape reproduced here.
    const defect = Object.assign(new Error("spawn tailscale ENOTDIR"), { code: "ENOTDIR" });
    const layer = layerSpawner(
      ChildProcessSpawner.make(() =>
        Effect.callback<never, never>(() => {
          throw defect;
        }),
      ),
    );

    return Effect.gen(function* () {
      const statusError = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(statusError, TailscaleCommandSpawnError);
      assert.equal(statusError.subcommand, "status");
      assert.strictEqual(statusError.cause, defect);

      const serveError = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(serveError, TailscaleCommandSpawnError);
      assert.equal(serveError.subcommand, "serve");
      assert.strictEqual(serveError.cause, defect);

      const degraded = yield* readTailscaleStatus.pipe(
        Effect.orElseSucceed(() => null),
        Effect.provide(layer),
      );
      assert.equal(degraded, null);
    });
  });

  it.effect("keeps nonzero exit diagnostics structured", () => {
    const layer = layerMockSpawner(() => ({
      code: 7,
      stderr: "not logged in tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.equal(error.exitCode, 7);
      assert.equal(error.stdoutLength, 0);
      assert.equal(error.stderrLength, 43);
      assert.notProperty(error, "command");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
      assert.equal(error.message, "tailscale status exited with code 7.");
      assert.equal(error.stderrDiagnostic, "not-logged-in");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
    });
  });

  // regression: #21609 - without forceKillAfter a timed-out probe only gets
  // SIGTERM, so a group member that ignores it outlives the call.
  it.effect("escalates timed-out probes to SIGKILL", () => {
    const killGraces: Array<number | undefined> = [];
    const layer = layerSpawner(
      ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") {
          const { forceKillAfter } = command.options;
          killGraces.push(
            forceKillAfter === undefined
              ? undefined
              : Duration.toMillis(Duration.fromInputUnsafe(forceKillAfter)),
          );
        }
        return Effect.succeed(mockHandle({ stdout: "{}" }));
      }),
    );

    return Effect.gen(function* () {
      yield* readTailscaleStatus.pipe(Effect.provide(layer));
      yield* readTailscaleSshEnabled.pipe(Effect.provide(layer));
      assert.deepEqual(killGraces, [500, 500]);
    });
  });

  it.live("leaves a Serve root that fronts another running server in place", () =>
    Effect.gen(function* () {
      const runningPort = yield* listenOnLoopback;
      const fixture = layerServeFixture(`http://127.0.0.1:${runningPort}`);

      const claimed = yield* claimTailscaleServe({ localPort: 3774 }).pipe(
        Effect.result,
        Effect.provide(fixture.layer),
      );
      assert.deepEqual(fixture.writes, []);
      assert.isTrue(
        Result.isFailure(claimed) && claimed.failure._tag === "TailscaleServeOccupiedError",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a Serve port that another app listens on as plain HTTP in place", () => {
    const fixture = layerServeFixture(null, { HTTP: true });

    return Effect.gen(function* () {
      const claimed = yield* claimTailscaleServe({ localPort: 3774 }).pipe(
        Effect.result,
        Effect.provide(fixture.layer),
      );
      assert.deepEqual(fixture.writes, []);
      assert.isTrue(
        Result.isFailure(claimed) && claimed.failure._tag === "TailscaleServeOccupiedError",
      );
    });
  });

  it.effect("leaves Funnel and foreground handlers untouched", () =>
    Effect.gen(function* () {
      for (const extra of [
        { AllowFunnel: { "desktop.tail.ts.net:443": true } },
        {
          Foreground: {
            session: {
              TCP: { "443": { HTTPS: true } },
              Web: {
                "desktop.tail.ts.net:443": {
                  Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } },
                },
              },
            },
          },
        },
      ]) {
        const fixture = layerServeFixture(null, { HTTPS: true }, extra);
        const claimed = yield* claimTailscaleServe({ localPort: 3773 }).pipe(
          Effect.result,
          Effect.provide(fixture.layer),
        );
        assert.isTrue(Result.isFailure(claimed));
        assert.isFalse(
          yield* releaseTailscaleServe({ localPort: 3773 }).pipe(Effect.provide(fixture.layer)),
        );
        assert.deepEqual(fixture.writes, []);
      }
    }),
  );

  it.effect("does not write when Serve status is unreadable", () =>
    Effect.gen(function* () {
      for (const stdout of ["", "not-json"]) {
        const writes: Array<ReadonlyArray<string>> = [];
        const layer = layerMockSpawner((_command, args) => {
          if (args.join(" ") === "serve status --json") return { stdout };
          writes.push(args);
          return {};
        });
        for (const operation of [claimTailscaleServe, releaseTailscaleServe]) {
          const error = yield* operation({ localPort: 3773 }).pipe(
            Effect.flip,
            Effect.provide(layer),
          );
          assert.instanceOf(error, TailscaleStatusParseError);
        }
        assert.deepEqual(writes, []);
      }
    }),
  );

  it.live("replaces a Serve root left behind by a stopped server", () =>
    Effect.gen(function* () {
      const stoppedPort = yield* Effect.scoped(listenOnLoopback);
      const fixture = layerServeFixture(`http://127.0.0.1:${stoppedPort}`);

      yield* claimTailscaleServe({ localPort: 3773 }).pipe(Effect.provide(fixture.layer));
      assert.deepEqual(fixture.writes, [["serve", "--bg", "--https=443", "http://127.0.0.1:3773"]]);
    }),
  );

  it.effect("removes only its own Serve root on release", () => {
    const fixture = layerServeFixture("http://127.0.0.1:3773");

    return Effect.gen(function* () {
      const releasedOther = yield* releaseTailscaleServe({ localPort: 3774 }).pipe(
        Effect.provide(fixture.layer),
      );
      assert.deepEqual(fixture.writes, []);
      assert.isFalse(releasedOther);

      const releasedOwn = yield* releaseTailscaleServe({ localPort: 3773 }).pipe(
        Effect.provide(fixture.layer),
      );
      assert.deepEqual(fixture.writes, [["serve", "--https=443", "--set-path=/", "off"]]);
      assert.isTrue(releasedOwn);
    });
  });
});

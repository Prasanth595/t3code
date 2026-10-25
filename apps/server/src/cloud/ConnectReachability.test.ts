// @effect-diagnostics nodeBuiltinImport:off - reads the user guide to check its anchors.
import * as NodeFS from "node:fs";

import { T3_CONNECT_TROUBLESHOOTING_SECTIONS } from "@t3tools/contracts";
import * as RelayClient from "@t3tools/shared/relayClient";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HttpClientError from "effect/http/HttpClientError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG } from "./config.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import { classifyReachability, type ReachabilityFacts } from "./ConnectReachability.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const checkedAt = "2026-10-19T00:00:00.000Z";
const connected = { pid: 1, readyConnections: 4, hostname: "env.example.test", protocol: "quic" };
const notConnected = { pid: 1, readyConnections: 0, hostname: null, protocol: null };
const facts = (overrides: Partial<ReachabilityFacts>): ReachabilityFacts => ({
  managedTunnelConfigured: true,
  connector: connected,
  endpoint: null,
  edgeReachable: null,
  exitNode: null,
  ...overrides,
});

describe("classifyReachability", () => {
  it.each([
    [{ kind: "status", status: 502 }, "origin_unreachable"],
    [{ kind: "status", status: 530 }, "no_connector"],
    [{ kind: "network_error" }, "timeout"],
  ] as const)("maps endpoint result %o to %s", (endpoint, cause) => {
    expect(classifyReachability(facts({ endpoint, edgeReachable: true }), checkedAt)).toMatchObject(
      { status: "unreachable", cause },
    );
  });

  it("keeps the endpoint cause when the TCP edge test cannot explain it", () => {
    // QUIC (UDP) can connect while TCP 7844 is blocked.
    expect(
      classifyReachability(
        facts({ endpoint: { kind: "status", status: 502 }, edgeReachable: false }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "origin_unreachable" });
    expect(
      classifyReachability(
        facts({
          connector: {
            pid: 1,
            readyConnections: null,
            hostname: "env.example.test",
            protocol: null,
          },
          endpoint: { kind: "status", status: 502 },
          edgeReachable: false,
        }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "origin_unreachable" });
    // Failed DNS also fails the edge lookups.
    expect(
      classifyReachability(
        facts({
          connector: {
            pid: 1,
            readyConnections: null,
            hostname: "env.example.test",
            protocol: null,
          },
          endpoint: { kind: "dns_failed" },
          edgeReachable: false,
        }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "dns_failed" });
  });

  it("waits on a connector that has not connected while the edge answers", () => {
    expect(
      classifyReachability(facts({ connector: notConnected, edgeReachable: true }), checkedAt),
    ).toMatchObject({ cause: "connector_not_ready" });
  });
});

const tunnelConfig = {
  providerKind: "cloudflare_tunnel" as const,
  connectorToken: "token",
  tunnelId: "tunnel-1",
};
const metricsHost = "127.0.0.1:20241";
const publicUrl = "https://env.example.test/.well-known/t3/environment";
const connectorStartup = new TextEncoder().encode(
  `2026-10-25T00:00:00Z INF Starting metrics server on ${metricsHost}/metrics\n` +
    "2026-10-25T00:00:00Z INF Registered tunnel connection connIndex=0 protocol=http2\n",
);

type PublicAnswer = "530" | "200" | "dns_failed" | "network_error";

// Real runtime and reachability; only cloudflared, its metrics server, and the public
// endpoint are fake. The metrics server keeps reporting four ready connections, as a
// connector the edge dropped after a host network change does.
const makeConnectFixture = Effect.fnUntraced(function* () {
  const started = yield* Queue.unbounded<number>();
  const killed: Array<number> = [];
  const publicAnswer = yield* Ref.make<PublicAnswer>("530");
  const publicGate = yield* Ref.make<{
    readonly entered: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  } | null>(null);
  let nextPid = 800;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command) || command.command !== "cloudflared") {
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "not installed",
        });
      }
      const pid = nextPid++;
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      let exited = false;
      const handle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: Deferred.await(exit),
        isRunning: Effect.sync(() => !exited),
        kill: () =>
          Effect.sync(() => {
            if (exited) return;
            exited = true;
            killed.push(pid);
            Deferred.doneUnsafe(exit, Exit.succeed(ChildProcessSpawner.ExitCode(143)));
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.concat(Stream.make(connectorStartup), Stream.never),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
      yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
      yield* Queue.offer(started, pid);
      return handle;
    }),
  );
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url === `http://${metricsHost}/ready`) {
        return HttpClientResponse.fromWeb(request, Response.json({ readyConnections: 4 }));
      }
      if (request.url === `http://${metricsHost}/config`) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ config: { ingress: [{ hostname: "env.example.test" }, {}] } }),
        );
      }
      if (request.url !== publicUrl) return yield* Effect.die(`unexpected ${request.url}`);
      const answer = yield* Ref.get(publicAnswer);
      const gate = yield* Ref.getAndSet(publicGate, null);
      if (gate) {
        yield* Deferred.succeed(gate.entered, undefined);
        yield* Deferred.await(gate.release);
      }
      if (answer === "530" || answer === "200") {
        return HttpClientResponse.fromWeb(request, new Response(null, { status: Number(answer) }));
      }
      return yield* new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          cause: Object.assign(new Error(answer), {
            code: answer === "dns_failed" ? "ENOTFOUND" : "ECONNRESET",
          }),
        }),
      });
    }),
  );
  const runtimeLayer = ManagedEndpointRuntime.layer.pipe(
    Layer.provide(
      Layer.succeed(
        RelayClient.RelayClient,
        RelayClient.RelayClient.of({
          resolve: Effect.succeed({
            status: "available",
            executablePath: "cloudflared",
            source: "path",
            version: RelayClient.CLOUDFLARED_VERSION,
          }),
          install: Effect.die("unused"),
          installWithProgress: () => Effect.die("unused"),
          pruneManagedVersions: Effect.void,
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    ConnectReachability.layer.pipe(
      Layer.provideMerge(runtimeLayer),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, httpClient),
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: (name) =>
              Effect.succeed(
                name === CLOUD_ENDPOINT_RUNTIME_CONFIG
                  ? Option.some(new Uint8Array())
                  : Option.none(),
              ),
          }),
        ),
      ),
    ),
  );
  const runtime = yield* Effect.service(ManagedEndpointRuntime.CloudManagedEndpointRuntime).pipe(
    Effect.provide(context),
  );
  const reachability = yield* Effect.service(ConnectReachability.ConnectReachability).pipe(
    Effect.provide(context),
  );
  /** Waits for the next cloudflared to start and register, so checks see its metrics. */
  const nextConnector = Effect.gen(function* () {
    const pid = yield* Queue.take(started);
    yield* Stream.runHead(runtime.tunnelConnected);
    return pid;
  });
  /** Starts a check and holds it at the public probe, after it read the connector. */
  const holdCheck = Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Ref.set(publicGate, { entered, release });
    const fiber = yield* reachability.check.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    return { release: Deferred.succeed(release, undefined), result: Fiber.join(fiber) };
  });
  return { runtime, reachability, killed, publicAnswer, nextConnector, holdCheck };
});

describe("ConnectReachability stale connector recovery", () => {
  it.effect("restarts cloudflared when Cloudflare has no connector but it reports ready", () =>
    Effect.gen(function* () {
      const fixture = yield* makeConnectFixture();
      yield* fixture.runtime.applyConfig(tunnelConfig);
      expect(yield* fixture.nextConnector).toBe(800);

      expect(yield* fixture.reachability.check).toMatchObject({ cause: "no_connector" });
      expect(fixture.killed).toEqual([]);

      yield* TestClock.adjust(Duration.minutes(2));
      expect(yield* fixture.reachability.check).toMatchObject({ cause: "no_connector" });
      expect(fixture.killed).toEqual([800]);
      expect(yield* fixture.nextConnector).toBe(801);

      yield* Ref.set(fixture.publicAnswer, "200");
      expect(yield* fixture.reachability.check).toMatchObject({ status: "reachable" });
    }),
  );

  it.effect("backs off restarts while Cloudflare keeps reporting no connector", () =>
    Effect.gen(function* () {
      const fixture = yield* makeConnectFixture();
      yield* fixture.runtime.applyConfig(tunnelConfig);
      yield* fixture.nextConnector;
      yield* fixture.reachability.check;
      yield* TestClock.adjust(Duration.minutes(2));
      yield* fixture.reachability.check;
      expect(fixture.killed).toEqual([800]);
      expect(yield* fixture.nextConnector).toBe(801);

      yield* fixture.reachability.check;
      yield* TestClock.adjust(Duration.minutes(2));
      yield* fixture.reachability.check;
      expect(fixture.killed).toEqual([800]);

      yield* TestClock.adjust(Duration.minutes(2));
      yield* fixture.reachability.check;
      expect(fixture.killed).toEqual([800, 801]);
      expect(yield* fixture.nextConnector).toBe(802);
    }),
  );

  it.effect("needs a new streak after a healthy, DNS, or network result", () =>
    Effect.gen(function* () {
      const fixture = yield* makeConnectFixture();
      yield* fixture.runtime.applyConfig(tunnelConfig);
      yield* fixture.nextConnector;
      for (const answer of ["200", "dns_failed", "network_error"] as const) {
        yield* Ref.set(fixture.publicAnswer, "530");
        expect(yield* fixture.reachability.check).toMatchObject({ cause: "no_connector" });
        yield* TestClock.adjust(Duration.minutes(2));
        yield* Ref.set(fixture.publicAnswer, answer);
        expect(yield* fixture.reachability.check).toMatchObject(
          answer === "200"
            ? { status: "reachable" }
            : { cause: answer === "dns_failed" ? "dns_failed" : "timeout" },
        );
      }
      yield* Ref.set(fixture.publicAnswer, "530");
      yield* fixture.reachability.check;
      expect(fixture.killed).toEqual([]);
    }),
  );

  it.effect("does not count a check that finishes after a newer one", () =>
    Effect.gen(function* () {
      const fixture = yield* makeConnectFixture();
      yield* fixture.runtime.applyConfig(tunnelConfig);
      yield* fixture.nextConnector;
      yield* fixture.reachability.check;
      yield* TestClock.adjust(Duration.minutes(2));

      const older = yield* fixture.holdCheck;
      yield* Ref.set(fixture.publicAnswer, "200");
      expect(yield* fixture.reachability.check).toMatchObject({ status: "reachable" });
      yield* older.release;
      expect(yield* older.result).toMatchObject({ cause: "no_connector" });

      yield* Ref.set(fixture.publicAnswer, "530");
      yield* TestClock.adjust(Duration.minutes(2));
      yield* fixture.reachability.check;
      expect(fixture.killed).toEqual([]);
    }),
  );

  it.effect("ignores a dead-connector result once its connector is replaced or removed", () =>
    Effect.gen(function* () {
      for (const nextConfig of [{ ...tunnelConfig, connectorToken: "replacement" }, null]) {
        yield* Effect.gen(function* () {
          const fixture = yield* makeConnectFixture();
          yield* fixture.runtime.applyConfig(tunnelConfig);
          yield* fixture.nextConnector;
          yield* fixture.reachability.check;
          yield* TestClock.adjust(Duration.minutes(2));

          const held = yield* fixture.holdCheck;
          yield* fixture.runtime.applyConfig(nextConfig);
          yield* held.release;
          expect(yield* held.result).toMatchObject({ cause: "no_connector" });

          expect(fixture.killed).toEqual([800]);
          if (nextConfig) {
            expect(yield* fixture.nextConnector).toBe(801);
            expect(yield* fixture.runtime.inspectConnector).not.toBeNull();
          } else {
            expect(yield* fixture.runtime.inspectConnector).toBeNull();
          }
        }).pipe(Effect.scoped);
      }
    }),
  );
});

describe("T3 Connect troubleshooting links", () => {
  it("each section names a heading in the user guide", () => {
    const guide = NodeFS.readFileSync(
      new URL("../../../../docs/user/t3-connect-troubleshooting.md", import.meta.url),
      "utf8",
    );
    // GitHub's heading anchors: lowercase, drop punctuation, spaces become hyphens.
    const anchors = new Set(
      [...guide.matchAll(/^#{2,3} (.+)$/gm)].map(([, heading]) =>
        heading!
          .toLowerCase()
          .replace(/[^\p{L}\p{N} _-]/gu, "")
          .replace(/ /g, "-"),
      ),
    );
    for (const section of T3_CONNECT_TROUBLESHOOTING_SECTIONS) {
      expect(anchors, section).toContain(section);
    }
  });
});

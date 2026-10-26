// @effect-diagnostics nodeBuiltinImport:off - reads the user guide to check its anchors.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";

import { T3_CONNECT_TROUBLESHOOTING_SECTIONS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import { classifyReachability, type ReachabilityFacts } from "./ConnectReachability.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

vi.mock("node:net", { spy: true });

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
    [{ kind: "status", status: 530, cloudflareError: "1033" }, "no_connector"],
    [{ kind: "status", status: 530, cloudflareError: "1016" }, "unexpected_response"],
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

describe("ConnectReachability stale connector recovery", () => {
  it.effect("restarts cloudflared when Cloudflare has no connector but it reports ready", () =>
    Effect.gen(function* () {
      using _connect = vi.spyOn(NodeNet, "connect").mockImplementation(() => {
        const socket = new NodeNet.Socket();
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      });
      const restarts = yield* Queue.unbounded<number>();
      let status = 530;
      let body = "error code: 1033";
      const layer = ConnectReachability.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({
              inspectConnector: Effect.succeed(connected),
              readinessChanged: Stream.never,
              restartConnector: (pid, stillDead) =>
                stillDead.pipe(
                  Effect.tap((dead) => (dead ? Queue.offer(restarts, pid) : Effect.void)),
                ),
            }),
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: () => Effect.succeedSome(new Uint8Array()),
            }),
            // Cloudflare answers 530 while cloudflared still reports four ready connections.
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
              ),
            ),
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() => Effect.die("no tailscale")),
            ),
          ),
        ),
      );
      // The scheduled checks run in the layer's scope, so the assertions run inside it.
      yield* Effect.gen(function* () {
        const reachability = yield* ConnectReachability.ConnectReachability;

        // The first sighting schedules its own confirming check two minutes later.
        expect(yield* reachability.check).toMatchObject({ cause: "no_connector" });
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.size(restarts)).toBe(0);
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);

        // A restart that did not help doubles the wait.
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.size(restarts)).toBe(0);
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);

        // Reaching the endpoint resets the wait, and a 530 for a broken DNS record is left alone.
        status = 200;
        expect(yield* reachability.check).toMatchObject({ status: "reachable" });
        status = 530;
        body = "error code: 1016";
        expect(yield* reachability.check).toMatchObject({ cause: "unexpected_response" });
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.size(restarts)).toBe(0);

        body = "error code: 1033";
        yield* reachability.check;
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Queue.take(restarts)).toBe(connected.pid);
      }).pipe(Effect.provide(layer));
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

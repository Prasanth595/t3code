// Real sockets stand in for another process holding the port on one address.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerConfig from "./config.ts";
import * as HttpListener from "./httpListener.ts";

// Holding 127.0.0.2 needs Linux's whole-127/8 loopback, and the wildcard
// conflict below is Linux bind semantics; other platforms allow or refuse differently.
const notLinux = HostProcess.Platform.defaultValue() !== "linux";

const holdPort = (host: string) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer();
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen(0, host, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  ).pipe(Effect.map((server) => (server.address() as NodeNet.AddressInfo).port));

const listen = (
  overrides: Pick<ServerConfig.ServerConfig["Service"], "host" | "port"> & {
    readonly privateNetworkOnly?: boolean;
  },
) =>
  Effect.gen(function* () {
    const base = yield* ServerConfig.ServerConfig;
    const context = yield* Layer.build(
      HttpListener.layer.pipe(Layer.provide(ServerConfig.layer({ ...base, ...overrides }))),
    );
    const config = Context.get(context, ServerConfig.ServerConfig);
    return {
      address: NetAddress.formatSocketAddress(Context.get(context, HttpServer.HttpServer).address),
      host: config.host,
      privateNetworkOnly: config.privateNetworkOnly,
    };
  });

const addressInUse = (error: { readonly cause: unknown }) =>
  (error.cause as NodeJS.ErrnoException).code === "EADDRINUSE";

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-http-listener-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("HttpListener.layer", (it) => {
  it.effect("keeps the private-network wildcard listener when the port is free", () =>
    Effect.gen(function* () {
      const bound = yield* listen({ host: "0.0.0.0", port: 0, privateNetworkOnly: true });
      assert.match(bound.address, /^0\.0\.0\.0:\d+$/);
      assert.strictEqual(bound.host, "0.0.0.0");
      assert.strictEqual(bound.privateNetworkOnly, true);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(notLinux)("falls back to loopback when another address holds the port", () =>
    Effect.gen(function* () {
      const port = yield* holdPort("127.0.0.2");
      const bound = yield* listen({ host: "0.0.0.0", port, privateNetworkOnly: true });
      assert.strictEqual(bound.address, `127.0.0.1:${port}`);
      assert.strictEqual(bound.host, "127.0.0.1");
      assert.strictEqual(bound.privateNetworkOnly, false);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(notLinux)("fails an explicit wildcard host instead of falling back", () =>
    Effect.gen(function* () {
      const port = yield* holdPort("127.0.0.2");
      const error = yield* Effect.flip(listen({ host: "0.0.0.0", port }));
      assert.isTrue(addressInUse(error));
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(notLinux)("fails when loopback holds the port too", () =>
    Effect.gen(function* () {
      const port = yield* holdPort("127.0.0.1");
      const error = yield* Effect.flip(listen({ host: "0.0.0.0", port, privateNetworkOnly: true }));
      assert.isTrue(addressInUse(error));
    }).pipe(Effect.scoped),
  );
});

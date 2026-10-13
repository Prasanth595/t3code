// @effect-diagnostics nodeBuiltinImport:off - the test needs a raw TCP server that never answers.
/**
 * Fork: machine map. A portal session that ends before its socket opens must not crash the
 * server. `ws` emits "error" on such a close, and an unheard "error" event ends the process.
 */
import * as NodeNet from "node:net";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { runPortalSession } from "./portalConnection.ts";

it.live("runPortalSession ends a session whose socket never opens without an unheard error", () =>
  Effect.gen(function* () {
    const connected = yield* Deferred.make<void>();
    // Accepts the TCP connection and never answers, so the WebSocket stays CONNECTING.
    const server = yield* Effect.acquireRelease(
      Effect.callback<NodeNet.Server>((resume) => {
        const held: NodeNet.Socket[] = [];
        const created = NodeNet.createServer((socket) => {
          held.push(socket);
          Deferred.doneUnsafe(connected, Effect.void);
        });
        created.on("close", () => held.forEach((socket) => socket.destroy()));
        created.listen(0, "127.0.0.1", () => resume(Effect.succeed(created)));
      }),
      (created) =>
        Effect.sync(() => {
          created.close();
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* Effect.die("The test server has no port.");
    }

    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", record);
    yield* Effect.addFinalizer(() => Effect.sync(() => process.off("uncaughtException", record)));

    const session = yield* runPortalSession({
      portalUrl: `http://127.0.0.1:${address.port}`,
      token: { clientId: "client.access", secret: "secret" },
      onOpen: () => Effect.void,
      onMessage: () => Effect.void,
    }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructorWS), Effect.forkChild);

    yield* Deferred.await(connected);
    yield* Fiber.interrupt(session);
    // The "error" from closing a CONNECTING socket arrives on a later tick.
    yield* Effect.sleep("100 millis");

    expect(uncaught).toEqual([]);
  }).pipe(Effect.scoped),
);

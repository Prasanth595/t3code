import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";

import * as WsConnectionLog from "./WsConnectionLog.ts";

const closingSocket = (code: number, closeReason: string) =>
  Socket.make({
    reader: Effect.succeed({
      pull: Effect.fail(
        new Socket.SocketError({ reason: new Socket.SocketCloseError({ code, closeReason }) }),
      ),
      upgrade: () => Effect.void,
    }),
    writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
  });

const connectedAtMs = Date.UTC(2026, 9, 23, 12, 21, 0);

describe("WsConnectionLog", () => {
  it.effect("keeps the close code that the RPC server swallows", () =>
    Effect.gen(function* () {
      const observation = WsConnectionLog.makeObservation();
      const { httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
      // Only `upgrade` is read by the websocket protocol.
      const request = HttpServerRequest.fromWeb(new Request("http://localhost/ws"));
      const upgradeable = new Proxy(request, {
        get: (target, key) =>
          key === "upgrade"
            ? Effect.succeed(closingSocket(4001, "heartbeat timeout"))
            : Reflect.get(target, key, target),
      });
      const exit = yield* httpEffect.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          WsConnectionLog.observeUpgrade(upgradeable, observation),
        ),
        Effect.exit,
      );
      // The RPC server ends the connection as a success, so the code is all there is.
      assert.isTrue(Exit.isSuccess(exit));
      assert.strictEqual(observation.closeCode, 4001);
      assert.strictEqual(observation.closeReason, "heartbeat timeout");
    }).pipe(Effect.scoped, Effect.provide(RpcSerialization.layerJson)),
  );

  it("tells a dropped connection from a close frame, invalidation and shutdown", () => {
    const describeClose = (
      observation: Partial<WsConnectionLog.WsConnectionObservation>,
      exit: Exit.Exit<unknown, unknown> = Exit.void,
    ) =>
      WsConnectionLog.wsCloseAttributes({
        observation: { ...WsConnectionLog.makeObservation(), ...observation },
        exit,
        connectedAtMs,
        closedAtMs: connectedAtMs + 60_000,
      });

    assert.deepStrictEqual(
      describeClose({ closeCode: 1006, lastInboundAtMs: connectedAtMs + 44_000 }),
      {
        endedBy: "connection_lost",
        closeCode: 1006,
        durationMs: 60_000,
        lastInboundAgeMs: 16_000,
      },
    );
    assert.strictEqual(describeClose({ closeCode: 1000 }).endedBy, "close_frame");
    // Invalidation interrupts the socket, so no close code reaches the reader.
    assert.strictEqual(describeClose({ invalidated: true }).endedBy, "session_invalidated");
    assert.strictEqual(describeClose({}, Exit.interrupt()).endedBy, "server_interrupted");
    assert.strictEqual(describeClose({}, Exit.die("boom")).endedBy, "server_error");
  });
});

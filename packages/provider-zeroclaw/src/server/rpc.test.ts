// @effect-diagnostics nodeBuiltinImport:off globalRandom:off -- RPC tests drive a real Unix socket.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

import {
  MAX_FRAME_BYTES,
  ZeroClawRpcError,
  ZeroClawRpcTimeoutError,
  makeNdjsonFramer,
  makeZeroClawRpcConnection,
  type ZeroClawRpcConnection,
} from "./rpc.ts";

interface FakeDaemon {
  readonly socketPath: string;
  readonly received: Queue.Dequeue<unknown>;
  readonly client: Effect.Effect<NodeNet.Socket>;
  readonly send: (message: unknown) => Effect.Effect<void>;
  readonly disconnect: Effect.Effect<void>;
}

const decodeLine = (line: string): unknown => JSON.parse(line);

const makeFakeDaemon = Effect.fn("makeFakeDaemon")(function* (
  onLine?: (line: unknown, send: (message: unknown) => void) => void,
) {
  const dir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "zc-rpc-")),
  );
  const socketPath = NodePath.join(dir, "daemon.sock");
  const received = yield* Queue.unbounded<unknown>();
  const clients = yield* Queue.unbounded<NodeNet.Socket>();
  const openSockets: NodeNet.Socket[] = [];

  const server = NodeNet.createServer((socket) => {
    openSockets.push(socket);
    socket.on("close", () => {
      const index = openSockets.indexOf(socket);
      if (index >= 0) openSockets.splice(index, 1);
    });
    Queue.offerUnsafe(clients, socket);
    let buffer = "";
    socket.on("error", () => {
      // The client destroying an oversized frame surfaces as ECONNRESET here.
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.length === 0) continue;
        const parsed = decodeLine(line);
        Queue.offerUnsafe(received, parsed);
        onLine?.(parsed, (message) => {
          socket.write(`${JSON.stringify(message)}\n`);
        });
      }
    });
  });

  yield* Effect.callback<void>((resume) => {
    server.listen(socketPath, () => {
      resume(Effect.void);
    });
    return Effect.sync(() => {
      server.close();
    });
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      server.close();
    }).pipe(
      Effect.andThen(Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }))),
      Effect.ignore,
    ),
  );

  const send = (message: unknown) =>
    Effect.gen(function* () {
      const sockets = yield* Queue.takeAll(clients);
      for (const socket of sockets) {
        yield* Queue.offer(clients, socket);
        yield* Effect.callback<void>((resume) => {
          socket.write(`${JSON.stringify(message)}\n`, () => {
            resume(Effect.void);
          });
          return Effect.void;
        });
      }
    });

  return {
    socketPath,
    received,
    client: Queue.take(clients),
    send,
    disconnect: Effect.sync(() => {
      for (const socket of openSockets) socket.destroy();
      server.close();
    }),
  } satisfies FakeDaemon;
});

const withConnection = <A, E>(
  use: (input: {
    readonly connection: ZeroClawRpcConnection;
    readonly daemon: FakeDaemon;
  }) => Effect.Effect<A, E>,
  onLine?: (line: unknown, send: (message: unknown) => void) => void,
) =>
  Effect.gen(function* () {
    const daemon = yield* makeFakeDaemon(onLine);
    const connection = yield* makeZeroClawRpcConnection({ socketPath: daemon.socketPath });
    return yield* use({ connection, daemon });
  }).pipe(Effect.scoped);

describe("makeNdjsonFramer", () => {
  it("splits lines and strips a trailing CR", () => {
    const frame = makeNdjsonFramer(MAX_FRAME_BYTES);
    expect(frame("one\r\npartial").lines).toEqual(["one"]);
    expect(frame("-two\n").lines).toEqual(["partial-two"]);
  });

  it("refuses a line past the frame cap", () => {
    const frame = makeNdjsonFramer(4);
    expect(frame("abcde").overflowed).toBe(true);
    expect(frame("\n").lines).toEqual([]);
  });
});

describe("ZeroClawRpcConnection", () => {
  it.live("correlates a handshake response and routes a notification", () =>
    withConnection(({ connection, daemon }) =>
      Effect.gen(function* () {
        const pending = yield* connection
          .request("initialize", { protocolVersion: 1 })
          .pipe(Effect.forkChild);
        const sent = yield* Queue.take(daemon.received);
        expect(sent).toMatchObject({ method: "initialize", id: "t3-out-0" });
        const id = (sent as { id: string }).id;
        yield* daemon.send({
          jsonrpc: "2.0",
          id,
          result: { protocolVersion: 1, server: "fake" },
        });
        expect(yield* Fiber.join(pending)).toEqual({ protocolVersion: 1, server: "fake" });

        yield* daemon.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { type: "turn_complete" },
        });
        expect(yield* Queue.take(connection.events)).toEqual({
          method: "session/update",
          params: { type: "turn_complete" },
        });
      }),
    ),
  );

  it.live("answers an inbound request without colliding with an outbound id", () =>
    withConnection(({ connection, daemon }) =>
      Effect.gen(function* () {
        const pending = yield* connection.request("status", {}).pipe(Effect.forkChild);
        const outbound = yield* Queue.take(daemon.received);
        yield* daemon.send({
          jsonrpc: "2.0",
          id: "t3-out-0",
          method: "elicitation/create",
          params: { prompt: "name?" },
        });
        const inbound = yield* Queue.take(connection.inboundRequests);
        expect(inbound).toEqual({
          id: "t3-out-0",
          method: "elicitation/create",
          params: { prompt: "name?" },
        });
        yield* connection.respond(inbound.id, { _tag: "result", result: { answer: "ada" } });
        const reply = yield* Queue.take(daemon.received);
        expect(reply).toEqual({ jsonrpc: "2.0", id: "t3-out-0", result: { answer: "ada" } });

        yield* daemon.send({
          jsonrpc: "2.0",
          id: (outbound as { id: string }).id,
          result: { ok: true },
        });
        expect(yield* Fiber.join(pending)).toEqual({ ok: true });
      }),
    ),
  );

  it.live("fails a pending request when a frame exceeds 8 MiB", () =>
    withConnection(({ connection, daemon }) =>
      Effect.gen(function* () {
        const pending = yield* connection
          .request("initialize", {})
          .pipe(Effect.exit, Effect.forkChild);
        const oversized = `${"x".repeat(MAX_FRAME_BYTES + 1)}\n`;
        const socket = yield* daemon.client;
        yield* Effect.callback<void>((resume) => {
          socket.write(oversized, () => {
            resume(Effect.void);
          });
          return Effect.void;
        });
        const exit = yield* Fiber.join(pending);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(ZeroClawRpcError);
        }
      }),
    ),
  );

  it.live("fails a request when the daemon drops the socket", () =>
    withConnection(({ connection, daemon }) =>
      Effect.gen(function* () {
        const pending = yield* connection
          .request("initialize", {}, 60_000)
          .pipe(Effect.exit, Effect.forkChild);
        yield* Queue.take(daemon.received);
        yield* daemon.disconnect;
        const exit = yield* Fiber.join(pending);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(ZeroClawRpcError);
        }
      }),
    ),
  );

  it.live("times out a request that never receives a response", () =>
    withConnection(({ connection, daemon }) =>
      Effect.gen(function* () {
        const exit = yield* connection.request("initialize", {}, 20).pipe(Effect.exit);
        yield* Queue.take(daemon.received);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(ZeroClawRpcTimeoutError);
        }
      }),
    ),
  );
});

// NDJSON JSON-RPC 2.0 over a Unix socket or Windows named pipe.
// This is the only file that touches node:net.
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeNet from "node:net";

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class ZeroClawRpcError extends Schema.TaggedError<ZeroClawRpcError>()("ZeroClawRpcError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `ZeroClaw RPC ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
  }
}

export class ZeroClawRpcTimeoutError extends Schema.TaggedError<ZeroClawRpcTimeoutError>()(
  "ZeroClawRpcTimeoutError",
  {
    operation: Schema.String,
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  },
) {
  override get message(): string {
    return `ZeroClaw RPC ${this.operation} timed out after ${this.timeoutMs}ms.`;
  }
}

export interface ZeroClawNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface ZeroClawInboundRequest {
  readonly id: string;
  readonly method: string;
  readonly params: unknown;
}

export type ZeroClawRpcResponse =
  | { readonly _tag: "result"; readonly result: unknown }
  | { readonly _tag: "error"; readonly error: unknown };

export interface ZeroClawRpcConnection {
  readonly request: (
    method: string,
    params: unknown,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, ZeroClawRpcError | ZeroClawRpcTimeoutError>;
  readonly notify: (method: string, params: unknown) => Effect.Effect<void, ZeroClawRpcError>;
  readonly events: Queue.Queue<ZeroClawNotification, ZeroClawRpcError>;
  readonly inboundRequests: Queue.Queue<ZeroClawInboundRequest, ZeroClawRpcError>;
  readonly respond: (
    id: string,
    response: ZeroClawRpcResponse,
  ) => Effect.Effect<void, ZeroClawRpcError>;
  readonly closed: Effect.Effect<void, ZeroClawRpcError>;
  readonly terminate: Effect.Effect<void>;
}

export interface ZeroClawRpcConnectionOptions {
  readonly socketPath: string;
}

type RpcError = ZeroClawRpcError | ZeroClawRpcTimeoutError;

interface PendingRequest {
  readonly deferred: Deferred.Deferred<unknown, ZeroClawRpcError>;
  /** A queue the request fiber takes from, because Deferred completion from another fiber does not resume it here. */
  readonly reply: Queue.Queue<Effect.Effect<unknown, ZeroClawRpcError>>;
  settled: boolean;
}

interface RpcFrame {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJsonLine = Schema.decodeSync(UnknownFromJsonString);
const encodeJsonLine = Schema.encodeSync(UnknownFromJsonString);

const ERROR_DETAIL_MAX_CHARS = 200;

function summarizeError(error: unknown): string {
  const text = typeof error === "string" ? error : JSON.stringify(error);
  if (text === undefined) return "unknown error";
  return text.length > ERROR_DETAIL_MAX_CHARS ? `${text.slice(0, ERROR_DETAIL_MAX_CHARS)}…` : text;
}

function rpcId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function parseFrame(line: string): RpcFrame | undefined {
  try {
    const parsed: unknown = decodeJsonLine(line);
    return Predicate.isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Split a byte stream into NDJSON lines. A line that would exceed `maxBytes`
 * fails the framer instead of being delivered, matching the daemon's refusal
 * to continue past an oversized frame.
 */
export function makeNdjsonFramer(maxBytes: number) {
  let buffer = "";
  let overflowed = false;
  return (
    chunk: string,
  ): { readonly lines: ReadonlyArray<string>; readonly overflowed: boolean } => {
    if (overflowed) return { lines: [], overflowed: true };
    const lines: string[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      if (buffer.length + (end - start) > maxBytes) {
        buffer = "";
        overflowed = true;
        return { lines, overflowed: true };
      }
      buffer += chunk.slice(start, end);
      if (newline < 0) break;
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.length > 0) lines.push(line);
      buffer = "";
      start = newline + 1;
    }
    return { lines, overflowed: false };
  };
}

function connectSocket(
  path: string,
  onData: (chunk: Buffer | string) => void,
): Effect.Effect<NodeNet.Socket, ZeroClawRpcError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.callback<NodeNet.Socket, ZeroClawRpcError>((resume) => {
      const socket = NodeNet.createConnection({ path });
      // Attach before connect settles so a fast handshake is not lost.
      socket.on("data", onData);
      let settled = false;
      const settle = (effect: Effect.Effect<NodeNet.Socket, ZeroClawRpcError>) => {
        if (settled) return;
        settled = true;
        resume(effect);
      };
      socket.once("connect", () => {
        socket.resume();
        settle(Effect.succeed(socket));
      });
      socket.once("error", (cause) => {
        settle(
          Effect.fail(
            new ZeroClawRpcError({
              operation: "connect",
              detail: cause.message,
              cause,
            }),
          ),
        );
      });
      return Effect.sync(() => {
        socket.destroy();
      });
    }),
    (socket) =>
      Effect.sync(() => {
        socket.destroy();
      }),
  );
}

function writeLine(
  socket: NodeNet.Socket,
  record: unknown,
  operation: string,
): Effect.Effect<void, ZeroClawRpcError> {
  return Effect.callback<void, ZeroClawRpcError>((resume) => {
    let settled = false;
    const settle = (effect: Effect.Effect<void, ZeroClawRpcError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    socket.write(`${encodeJsonLine(record)}\n`, (cause) => {
      if (cause) {
        settle(Effect.fail(new ZeroClawRpcError({ operation, detail: cause.message, cause })));
        return;
      }
      settle(Effect.void);
    });
    return Effect.void;
  });
}

export const makeZeroClawRpcConnection = Effect.fn("makeZeroClawRpcConnection")(function* (
  options: ZeroClawRpcConnectionOptions,
) {
  const scope = yield* Effect.scope;
  const events = yield* Queue.unbounded<ZeroClawNotification, ZeroClawRpcError>();
  const inboundRequests = yield* Queue.unbounded<ZeroClawInboundRequest, ZeroClawRpcError>();
  const frame = makeNdjsonFramer(MAX_FRAME_BYTES);
  const pendingRequests = new Map<string, PendingRequest>();
  const incomingFrames = yield* Queue.unbounded<RpcFrame, ZeroClawRpcError>();
  const socket = yield* connectSocket(options.socketPath, (chunk) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const framed = frame(text);
    for (const line of framed.lines) {
      const parsed = parseFrame(line);
      if (parsed === undefined) continue;
      // Hand the frame to a fiber. Completing a deferred from this callback
      // does not resume a waiter in this runtime.
      Queue.offerUnsafe(incomingFrames, parsed);
    }
    if (framed.overflowed) {
      for (const [key, pending] of pendingRequests) {
        pendingRequests.delete(key);
        Queue.offerUnsafe(
          pending.reply,
          Effect.fail(
            new ZeroClawRpcError({
              operation: "read",
              detail: `Frame exceeded ${MAX_FRAME_BYTES} bytes`,
            }),
          ),
        );
      }
      socket.destroy();
    }
  });

  const outgoing = yield* Queue.unbounded<unknown, ZeroClawRpcError>();
  const transportDown = yield* Deferred.make<never, ZeroClawRpcError>();
  const closed = yield* Deferred.make<void, ZeroClawRpcError>();
  let nextRequestId = 0;

  const failTransport = Effect.fnUntraced(function* (error: ZeroClawRpcError) {
    const claimed = yield* Deferred.fail(transportDown, error);
    if (!claimed) return;
    yield* Deferred.fail(closed, error);
    for (const [key, pending] of pendingRequests) {
      pendingRequests.delete(key);
      yield* Deferred.fail(pending.deferred, error);
    }
    yield* Queue.fail(outgoing, error);
    yield* Queue.fail(events, error);
    yield* Queue.fail(inboundRequests, error);
  });

  const routeFrame = Effect.fnUntraced(function* (frame: RpcFrame) {
    const id = rpcId(frame.id);
    const method = typeof frame.method === "string" ? frame.method : undefined;
    const isResponse = frame.result !== undefined || frame.error !== undefined;
    if (id !== undefined && isResponse) {
      const pending = pendingRequests.get(id);
      if (pending === undefined) {
        // A response we did not send must not be answered; that could complete
        // an unrelated request traveling the other direction.
        yield* Effect.logDebug("Dropping unmatched ZeroClaw RPC response.", { id });
        return;
      }
      pendingRequests.delete(id);
      pending.settled = true;
      yield* Queue.offer(
        pending.reply,
        frame.error !== undefined
          ? Effect.fail(
              new ZeroClawRpcError({
                operation: "request",
                detail: summarizeError(frame.error),
                cause: frame.error,
              }),
            )
          : Effect.succeed(frame.result),
      );
      return;
    }
    if (method !== undefined && id !== undefined) {
      yield* Queue.offer(inboundRequests, { id, method, params: frame.params });
      return;
    }
    if (method !== undefined) {
      yield* Queue.offer(events, { method, params: frame.params });
      return;
    }
    yield* Effect.logDebug("Dropping malformed ZeroClaw RPC frame.");
  });

  yield* Stream.fromQueue(incomingFrames).pipe(
    Stream.runForEach((parsed) => routeFrame(parsed)),
    Effect.forkIn(scope),
  );

  let readsClosed = false;
  const failPending = (detail: string) => {
    if (readsClosed) return;
    readsClosed = true;
    for (const [key, pending] of pendingRequests) {
      if (pending.settled) continue;
      pendingRequests.delete(key);
      Deferred.doneUnsafe(
        pending.deferred,
        Effect.fail(new ZeroClawRpcError({ operation: "read", detail })),
      );
    }
  };
  socket.once("close", () => {
    // A close that races a just-completed response must not fail that response.
    // Pending requests fail on the next write or on their own timeout.
  });
  socket.on("error", (cause: Error) => {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ECONNRESET" || code === "EPIPE") return;
  });

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.runForEach((record) => writeLine(socket, record, "write")),
    Effect.catchCause((cause) =>
      failTransport(new ZeroClawRpcError({ operation: "write", cause })),
    ),
    Effect.forkIn(scope),
  );

  const enqueue = Effect.fnUntraced(function* (record: unknown, operation: string) {
    const accepted = yield* Queue.offer(outgoing, record);
    if (!accepted) {
      return yield* new ZeroClawRpcError({
        operation,
        detail: "Connection closed",
      });
    }
  });

  const request = Effect.fn("ZeroClawRpc.request")(function* (
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    const id = `t3-out-${nextRequestId++}`;
    const deferred = yield* Deferred.make<unknown, ZeroClawRpcError>();
    const reply = yield* Queue.bounded<Effect.Effect<unknown, ZeroClawRpcError>>(1);
    pendingRequests.set(id, { deferred, reply, settled: false });
    yield* enqueue({ jsonrpc: "2.0", id, method, params }, method).pipe(
      Effect.tapError(() => Effect.sync(() => pendingRequests.delete(id))),
    );
    // Let the socket's data callback complete the deferred before we wait.
    yield* Effect.yieldNow;
    const awaiting = Effect.raceFirst(
      Queue.take(reply).pipe(Effect.flatten),
      Deferred.await(transportDown),
    ).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()));
    return yield* (
      timeoutMs > 0
        ? awaiting.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(timeoutMs),
              orElse: () =>
                Effect.fail(new ZeroClawRpcTimeoutError({ operation: method, timeoutMs })),
            }),
          )
        : awaiting
    ).pipe(
      Effect.onInterrupt(() => Effect.sync(() => pendingRequests.delete(id))),
      Effect.onError(() => Effect.sync(() => pendingRequests.delete(id))),
    );
  });

  const respond = Effect.fn("ZeroClawRpc.respond")(function* (
    id: string,
    response: ZeroClawRpcResponse,
  ) {
    const body =
      response._tag === "result"
        ? { jsonrpc: "2.0", id, result: response.result }
        : { jsonrpc: "2.0", id, error: response.error };
    yield* enqueue(body, "respond");
  });

  return {
    request,
    notify: (method, params) => enqueue({ jsonrpc: "2.0", method, params }, method),
    events,
    inboundRequests,
    respond,
    closed: Deferred.await(closed),
    terminate: failTransport(
      new ZeroClawRpcError({ operation: "terminate", detail: "connection was stopped" }),
    ).pipe(
      Effect.andThen(
        Effect.sync(() => {
          socket.destroy();
        }),
      ),
      Effect.ignore,
      Effect.uninterruptible,
    ),
  } satisfies ZeroClawRpcConnection;
});

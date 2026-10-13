/**
 * Fork: machine map. One WebSocket session with the portal at `<portal>/connect` (MM-1303).
 *
 * Cloudflare Access checks the machine token in the headers `CF-Access-Client-Id` and
 * `CF-Access-Client-Secret`. Liveness uses the text frames `ping` and `pong`: the Durable Object
 * answers them with its auto response, so a ping does not wake it (MM-1001).
 */
import { MachineToPortal, PortalToMachine } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";

import { type MachineToken, tokenHeaders } from "./MachineMapState.ts";

/** The portal must answer this text frame with `PORTAL_PONG` without waking (MM-1001). */
const PORTAL_PING = "ping";
const PORTAL_PONG = "pong";
const PING_INTERVAL = Duration.seconds(30);
/** No frame for this long means the connection is dead, even if TCP did not notice. */
const SILENCE_LIMIT = Duration.seconds(75);

const decodePortalMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(PortalToMachine));
const encodeMachineMessage = Schema.encodeEffect(Schema.fromJsonString(MachineToPortal));

export class PortalConnectionError extends Schema.TaggedError<PortalConnectionError>()(
  "PortalConnectionError",
  {
    reason: Schema.Literals(["open-failed", "closed", "silent"]),
    /** A short, safe description, such as `Unexpected server response: 403`. */
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Portal connection ${this.reason}: ${this.detail}`;
  }
}

/** `https://portal` to `wss://portal/connect`. */
const connectUrl = (portalUrl: string): string => {
  const url = new URL("/connect", portalUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
};

/** The `ws` error events carry a message such as `Unexpected server response: 403`. */
const describeSocketError = (error: Socket.SocketError): string => {
  const cause: unknown = "cause" in error.reason ? error.reason.cause : undefined;
  const message =
    typeof cause === "object" && cause !== null && "message" in cause
      ? (cause as { readonly message: unknown }).message
      : undefined;
  if (typeof message === "string" && message.length > 0) return message.slice(0, 200);
  return error.reason._tag === "SocketCloseError"
    ? `closed with code ${error.reason.code}`
    : error.reason._tag;
};

export type SendToPortal = (message: MachineToPortal) => Effect.Effect<void, Socket.SocketError>;

/**
 * Opens one session and runs until it ends. It always ends with a `PortalConnectionError`.
 * `onOpen` runs once the socket is open; `onMessage` runs for each portal message, in order.
 * Both run in the scope of the session, so a fiber that `onOpen` forks ends with the session.
 */
export const runPortalSession = <R1, R2>(input: {
  readonly portalUrl: string;
  readonly token: MachineToken;
  readonly onOpen: (send: SendToPortal) => Effect.Effect<void, never, R1>;
  readonly onMessage: (
    message: PortalToMachine,
    send: SendToPortal,
  ) => Effect.Effect<void, never, R2>;
}): Effect.Effect<
  never,
  PortalConnectionError,
  Socket.WebSocketConstructor | Exclude<R1 | R2, Scope.Scope>
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const makeWebSocket = yield* Socket.WebSocketConstructor;
      const socket = yield* Socket.fromWebSocket(
        Effect.acquireRelease(
          Effect.sync(() =>
            makeWebSocket(connectUrl(input.portalUrl), { headers: tokenHeaders(input.token) }),
          ),
          (webSocket) => Effect.sync(() => webSocket.close(1000)),
        ),
        { openTimeout: Duration.seconds(15) },
      );
      const pull = yield* Socket.readerString(socket).pipe(
        Effect.mapError(
          (error) =>
            new PortalConnectionError({
              reason: "open-failed",
              detail: describeSocketError(error),
            }),
        ),
      );
      const writer = yield* socket.writer;
      const send: SendToPortal = (message) =>
        encodeMachineMessage(message).pipe(
          Effect.orDie,
          Effect.flatMap((json) => writer.write(json)),
        );

      let lastFrameAt = yield* Clock.currentTimeMillis;
      const liveness = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(PING_INTERVAL);
          const silentFor = (yield* Clock.currentTimeMillis) - lastFrameAt;
          if (silentFor > Duration.toMillis(SILENCE_LIMIT)) {
            return yield* new PortalConnectionError({
              reason: "silent",
              detail: `no frame for ${Math.round(silentFor / 1000)} seconds`,
            });
          }
          yield* writer.write(PORTAL_PING).pipe(
            Effect.mapError(
              (error) =>
                new PortalConnectionError({
                  reason: "closed",
                  detail: describeSocketError(error),
                }),
            ),
          );
        }
      });

      const receive = Effect.gen(function* () {
        while (true) {
          const frames = yield* pull.pipe(
            Effect.mapError(
              (error) =>
                new PortalConnectionError({ reason: "closed", detail: describeSocketError(error) }),
            ),
          );
          lastFrameAt = yield* Clock.currentTimeMillis;
          for (const frame of frames) {
            if (frame === PORTAL_PONG) continue;
            const message = yield* decodePortalMessage(frame).pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Ignored a portal message that does not decode.", {
                  cause: String(cause).slice(0, 500),
                }),
              ),
              Effect.option,
            );
            if (message._tag === "Some") yield* input.onMessage(message.value, send);
          }
        }
      });

      yield* input.onOpen(send);
      return yield* Effect.raceFirst(receive, liveness);
    }),
  );

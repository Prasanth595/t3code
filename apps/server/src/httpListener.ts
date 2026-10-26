// Effect wraps this raw Node HTTP server after its startup and write-error guards attach.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ServeError } from "effect/http/HttpServerError";

import * as ServerConfig from "./config.ts";
import {
  guardHttpResponseWriteErrors,
  rejectRequestsUntilServing,
} from "./httpResponseErrorGuard.ts";
import { acceptsPrivateNetworkConnection } from "./startupAccess.ts";

// Skip Effect's default 20 s grace; WebSocket scope finalizers already close connections gracefully.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
const LOOPBACK_HOST = "127.0.0.1";

const isAddressInUse = (error: ServeError) =>
  typeof error.cause === "object" &&
  error.cause !== null &&
  "code" in error.cause &&
  error.cause.code === "EADDRINUSE";

const listen = (config: ServerConfig.ServerConfig["Service"]) =>
  NodeHttpServer.layer(
    () => {
      const server = rejectRequestsUntilServing(
        guardHttpResponseWriteErrors(NodeHttp.createServer()),
      );
      if (config.privateNetworkOnly) {
        server.on("connection", (socket) => {
          if (!acceptsPrivateNetworkConnection(socket)) {
            socket.destroy();
          }
        });
      }
      return server;
    },
    {
      host: config.host ?? LOOPBACK_HOST,
      port: config.port,
      gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
      // Context takeover stays enabled (ws default) so the compression
      // window is shared across frames — that also makes small frames cheap
      // to compress, so no size threshold is set (ws only honors
      // `threshold` when context takeover is disabled).
      websocket: { perMessageDeflate: true },
    },
  ).pipe(Layer.merge(ServerConfig.layer(config)));

/**
 * Re-provides `ServerConfig` with the host actually bound, so advertised
 * endpoints, pairing, and auth policy never describe a listener that failed.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (!config.privateNetworkOnly) return listen(config);
    // Another process (Tailscale Serve, for one) can hold this port on one
    // specific address, which blocks the wildcard bind but not loopback.
    return listen(config).pipe(
      Layer.catchTag("ServeError", (error) =>
        Layer.unwrap(
          isAddressInUse(error)
            ? Effect.logWarning(
                `Port ${config.port} is already in use on another address, so the server listens on ${LOOPBACK_HOST} only and other devices cannot reach it directly. Set T3CODE_HOST to choose an address.`,
                { cause: error.cause },
              ).pipe(
                Effect.as(listen({ ...config, host: LOOPBACK_HOST, privateNetworkOnly: false })),
              )
            : Effect.fail(error),
        ),
      ),
    );
  }),
);

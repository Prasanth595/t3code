// @effect-diagnostics nodeBuiltinImport:off -- exercise the installed Fetch transport against a real loopback redirect.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as Handshake from "./MissionPeerHandshake.ts";
import * as PeerHttp from "./MissionPeerHttp.ts";

it.effect(
  "refuses a real 302 without following it and requires the pinned final response URL",
  () => {
    let mode: "redirect" | "ok" | "wrong-url" = "redirect";
    let redirectedRequests = 0;
    let completedProofs = 0;
    let observedResponseUrl = "";
    return Effect.acquireUseRelease(
      Effect.callback<NodeHttp.Server>((resume) => {
        const server = NodeHttp.createServer((request, response) => {
          if (request.url === "/redirect-target") redirectedRequests += 1;
          if (mode === "redirect") {
            response.writeHead(302, { location: "/redirect-target" });
            response.end();
          } else {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"proof":"transport-fixture-only"}');
          }
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.gen(function* () {
          const address = server.address();
          if (address === null || typeof address === "string")
            return yield* Effect.die("Expected TCP address");
          const origin = `http://127.0.0.1:${address.port}`;
          const pinnedUrl = `${origin}${Handshake.MISSION_PEER_HANDSHAKE_PATH}`;
          const transportFetch = yield* FetchHttpClient.Fetch;
          const monitoredFetch: typeof globalThis.fetch = async (input, init) => {
            const response = await transportFetch(input, init);
            observedResponseUrl = response.url;
            // A custom Fetch implementation must not bypass the final URL pin.
            if (mode === "wrong-url")
              Object.defineProperty(response, "url", { value: `${origin}/elsewhere` });
            return response;
          };
          // Crypto/peer identity is deliberately outside this transport-only test.
          // Reaching complete is observable, but supplies no accepted host binding.
          const handshake = Handshake.MissionPeerHandshake.of({
            begin: Effect.succeed({
              nonce: "transport-fixture",
              origin,
              request: { proof: "transport-fixture-only" },
            }),
            answer: () =>
              Effect.fail(new Handshake.MissionPeerHandshakeError({ category: "unconfigured" })),
            complete: () =>
              Effect.sync(() => {
                completedProofs += 1;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new Handshake.MissionPeerHandshakeError({ category: "unconfigured" }),
                  ),
                ),
              ),
          });
          const attempt = Effect.gen(function* () {
            const peer = yield* PeerHttp.MissionPeerHttp;
            const result = yield* peer.connect.pipe(Effect.result);
            expect(result._tag).toBe("Failure");
            return result._tag === "Failure" ? result.failure.category : "unexpected-success";
          }).pipe(
            Effect.provide(PeerHttp.layer),
            Effect.provideService(Handshake.MissionPeerHandshake, handshake),
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(FetchHttpClient.Fetch, monitoredFetch),
            Effect.scoped,
          );
          expect(yield* attempt).toBe("transport");
          expect(redirectedRequests).toBe(0);
          expect(completedProofs).toBe(0);
          mode = "ok";
          expect(yield* attempt).toBe("unconfigured");
          expect(observedResponseUrl).toBe(pinnedUrl);
          expect(completedProofs).toBe(1);
          mode = "wrong-url";
          expect(yield* attempt).toBe("transport");
          expect(completedProofs).toBe(1);
        }),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
    );
  },
);

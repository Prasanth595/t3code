import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import type { HostTransportBinding } from "../../../../packages/contracts/src/missionHostProtocol.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as Handshake from "./MissionPeerHandshake.ts";

/**
 * The supplied HttpClient must use the existing peer-authorized environment
 * bearer/DPoP auth and reject redirects. No ambient token, auth exchange,
 * retries, or default Fetch client is installed here. The response signature
 * is verified independently of this outer HTTP authentication.
 */
export class MissionPeerHttp extends Context.Service<MissionPeerHttp, {
  readonly connect: Effect.Effect<HostTransportBinding, Handshake.MissionPeerHandshakeError>;
}>()("t3/orchestration-v2/MissionPeerHttp") {}

const make = Effect.gen(function* () {
  const handshake = yield* Handshake.MissionPeerHandshake;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const connect = Effect.gen(function* () {
    const pending = yield* handshake.begin;
    const response = yield* HttpClientRequest.post(`${pending.origin}${Handshake.MISSION_PEER_HANDSHAKE_PATH}`).pipe(
      HttpClientRequest.setHeader("cache-control", "no-store"),
      HttpClientRequest.bodyJson(pending.request),
      Effect.flatMap(client.execute),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Handshake.PeerProofEnvelope)),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(32 * 1024)),
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new Handshake.MissionPeerHandshakeError({ category: "transport" })),
    );
    return yield* handshake.complete(pending.nonce, response);
  }).pipe(Effect.scoped);
  return MissionPeerHttp.of({ connect });
});

export const layer = Layer.effect(MissionPeerHttp, make);

const headers = { "cache-control": "no-store", pragma: "no-cache" };
const failure = (status: number, error: string) => HttpServerResponse.jsonUnsafe({ error }, { status, headers });

/**
 * Root adds this route only with the handshake service context captured below.
 * An HTTP session grants route access, never peer identity. Only the independently
 * pinned signed request authorizes a receiver attestation. This route accepts no
 * readiness, claim, artifact, work request, controller epoch, or execution payload.
 */
export const routeLayer = HttpRouter.use((router) => Effect.gen(function* () {
  const handshake = yield* Handshake.MissionPeerHandshake;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (session._tag === "None") return failure(401, "authentication_required");
    if (!session.value.scopes.includes(AuthOrchestrationReadScope)) return failure(403, "scope_required");
    const payload = yield* request.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(32 * 1024)),
      Effect.flatMap(Schema.decodeUnknownEffect(Handshake.PeerProofEnvelope)),
      Effect.option,
    );
    if (payload._tag === "None") return failure(400, "invalid_peer_request");
    return yield* handshake.answer(payload.value).pipe(
      Effect.map((response) => HttpServerResponse.jsonUnsafe(response, { headers })),
      Effect.catchTags({
        MissionPeerHandshakeError: (error) => Effect.succeed(failure(
          error.category === "replay" ? 409 :
          error.category === "invalid_proof" || error.category === "expired" ? 401 : 503,
          error.category,
        )),
      }),
    );
  });
  yield* router.add("POST", Handshake.MISSION_PEER_HANDSHAKE_PATH, handler);
}));

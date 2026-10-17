import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Bootstrap from "./MissionPeerBootstrap.ts";
import * as Configuration from "./MissionPeerConfiguration.ts";
import { MissionPeerEntrypoint } from "./MissionPeerConfiguredReceiver.ts";
import * as Handshake from "./MissionPeerHandshake.ts";
import * as PeerHttp from "./MissionPeerHttp.ts";

/** Provisioned privately through the existing receiver pairing/token-exchange route. */
export const PEER_HTTP_BEARER_SECRET = "mission-peer-http-bearer";

/**
 * Optional source consumer. No pairing, credential minting, retries or remote call
 * occurs at construction. Missing pins/credential leave Combined's existing
 * host_unavailable result intact. A credential is never evidence of peer identity.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const configured = yield* Configuration.MissionPeerConfiguration;
    if (Option.isNone(configured)) return Layer.empty;
    const approvedPeer = configured.value;
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    if (environmentId !== approvedPeer.sourceEnvironmentId) return Layer.empty;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const transportError = () => new Handshake.MissionPeerHandshakeError({ category: "transport" });
    const readCredential = secrets.get(PEER_HTTP_BEARER_SECRET).pipe(
      Effect.mapError(transportError),
      Effect.flatMap((stored) => {
        if (Option.isNone(stored)) return Effect.succeedNone;
        const bytes = stored.value;
        if (bytes.byteLength === 0 || bytes.byteLength > 8192) return Effect.fail(transportError());
        return Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          catch: transportError,
        }).pipe(
          Effect.flatMap((token) =>
            /^[A-Za-z0-9\-._~+/]+=*$/.test(token)
              ? Effect.succeed(Option.some(token))
              : Effect.fail(transportError()),
          ),
        );
      }),
    );
    if (Option.isNone(yield* readCredential)) return Layer.empty;
    const entrypoint = yield* Effect.serviceOption(MissionPeerEntrypoint);
    if (Option.isNone(entrypoint)) {
      return yield* new Bootstrap.MissionPeerBootstrapError({ category: "unsupported_execution" });
    }
    const authenticatedClient = Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return client.pipe(
          HttpClient.mapRequestEffect((request) =>
            Effect.gen(function* () {
              // This dedicated client may send the credential only to the exact pinned
              // handshake URL. Fetch redirect:error is also enforced by PeerHttp.connect.
              if (
                request.method !== "POST" ||
                request.url !==
                  `${approvedPeer.receiverOrigin}${Handshake.MISSION_PEER_HANDSHAKE_PATH}` ||
                request.urlParams.params.length !== 0 ||
                Option.isSome(request.hash)
              ) {
                return yield* transportError();
              }
              const token = yield* readCredential;
              if (Option.isNone(token)) return yield* transportError();
              return HttpClientRequest.bearerToken(request, token.value);
            }).pipe(
              Effect.mapError(
                () =>
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: "Peer HTTP authentication unavailable.",
                    }),
                  }),
              ),
            ),
          ),
        );
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer));
    return PeerHttp.layer.pipe(
      Layer.provide(authenticatedClient),
      Layer.provide(Bootstrap.layer({ approvedPeer, entrypoint: entrypoint.value })),
    );
  }),
);

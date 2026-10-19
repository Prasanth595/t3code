import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { readDesktopPrimaryBearerToken } from "./desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "./target";

const isUnauthenticatedSession = Schema.is(Schema.Struct({ authenticated: Schema.Literal(false) }));

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }

  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

function withPrimaryBearerToken(client: HttpClient.HttpClient): HttpClient.HttpClient {
  return client.pipe(
    HttpClient.transform((effect, request) =>
      Effect.gen(function* () {
        const bearerToken = yield* Effect.promise(() => readDesktopPrimaryBearerToken());
        if (!bearerToken) return yield* effect;
        const response = yield* client.execute(HttpClientRequest.bearerToken(request, bearerToken));
        // The session probe reports a refused bearer as a successful anonymous response.
        const anonymousSession =
          response.status === 200 &&
          new URL(request.url).pathname === "/api/auth/session" &&
          isUnauthenticatedSession(yield* response.json);
        if (response.status !== 401 && !anonymousSession) return response;
        const refreshed = yield* Effect.promise(() => readDesktopPrimaryBearerToken(bearerToken));
        return refreshed
          ? yield* client.execute(HttpClientRequest.bearerToken(request, refreshed))
          : response;
      }),
    ),
  );
}

export function layerForCurrentOrigin() {
  return Layer.unwrap(
    Effect.sync(() => {
      const layerBase = layerRemoteHttpClient(globalThis.fetch);
      if (isSameOriginBrowserPrimary()) {
        return Layer.merge(
          layerBase,
          Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
        );
      }

      const layerBearerClient = Layer.effect(
        HttpClient.HttpClient,
        Effect.map(HttpClient.HttpClient, withPrimaryBearerToken),
      ).pipe(Layer.provide(layerBase));

      return Layer.merge(
        layerBearerClient,
        Layer.succeed(FetchHttpClient.RequestInit, { credentials: "omit" }),
      );
    }),
  );
}

export const layer = layerForCurrentOrigin();

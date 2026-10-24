import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";

import * as ForgejoCli from "./ForgejoCli.ts";

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };

export const make = Effect.gen(function* () {
  const cli = yield* ForgejoCli.ForgejoCli;
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);

  return Effect.fn("ForgejoMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const server = new URL(request.url);
    // Read on every fetch, so media loads as soon as the user signs in.
    const token = yield* cli.fjToken(server.host);
    let target = server;
    for (let hop = 0; ; hop += 1) {
      // Only the server the token belongs to sees it, never the object store a redirect hands
      // the file to.
      const authorization =
        token !== null && target.origin === server.origin ? `token ${token}` : null;
      const response: HttpClientResponse.HttpClientResponse = yield* httpClient
        .execute(
          HttpClientRequest.get(target.toString()).pipe(
            HttpClientRequest.setHeaders({
              ...request.headers,
              // The bytes are streamed straight through, so never let an encoding layer in.
              "accept-encoding": "identity",
              ...(authorization === null ? {} : { authorization }),
            }),
          ),
        )
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));
      const location = response.headers.location;
      if (response.status < 300 || response.status >= 400) return response;
      if (!location || hop >= MAX_REDIRECTS) return null;
      const next = new URL(location, target);
      if (next.protocol !== "https:") return null;
      target = next;
    }
  });
});

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoMediaFetch from "./forgejoMediaFetch.ts";

const UPLOAD = "/attachments/8e603325-bb2b-4e32-a9bc-f1fa20b6c40b";

const fetchWith = (
  routes: Record<string, { readonly status: number; readonly location?: string }>,
  sent: Array<[string, string | undefined]>,
) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.mock(ForgejoCli.ForgejoCli)({
        fjToken: (host) => Effect.succeed(host === "git.example.test" ? "fj-token" : null),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const url = new URL(request.url);
          sent.push([url.host, request.headers.authorization]);
          const route = routes[url.host] ?? { status: 404 };
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: route.status,
                headers: route.location ? { location: route.location } : {},
              }),
            ),
          );
        }),
      ),
    ),
  );

describe("ForgejoMediaFetch", () => {
  it.effect("sends fj's token to its server and never to a redirect target", () => {
    const sent: Array<[string, string | undefined]> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* ForgejoMediaFetch.make;
      const response = yield* fetchMedia({
        url: `https://git.example.test${UPLOAD}`,
        headers: { range: "bytes=0-1" },
      });
      expect(response?.status).toBe(200);
      expect(sent).toEqual([
        ["git.example.test", "token fj-token"],
        ["objects.example.test", undefined],
      ]);
    }).pipe(
      fetchWith(
        {
          "git.example.test": { status: 302, location: `https://objects.example.test${UPLOAD}` },
          "objects.example.test": { status: 200 },
        },
        sent,
      ),
      Effect.scoped,
    );
  });

  it.effect("loads an upload from a server fj has no login for without a credential", () => {
    const sent: Array<[string, string | undefined]> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* ForgejoMediaFetch.make;
      const response = yield* fetchMedia({ url: `https://codeberg.org${UPLOAD}`, headers: {} });
      expect(response?.status).toBe(200);
      expect(sent).toEqual([["codeberg.org", undefined]]);
    }).pipe(fetchWith({ "codeberg.org": { status: 200 } }, sent), Effect.scoped);
  });
});

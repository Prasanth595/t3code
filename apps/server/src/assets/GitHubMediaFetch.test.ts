import { describe, expect, it } from "@effect/vitest";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse, HttpServerResponse } from "effect/http";
import { githubMediaResponse } from "./GitHubMediaFetch.ts";

const asset = {
  url: "https://github.com/owner/private/releases/download/v1%2Btest/shot%20%231%25.png",
  cwd: "/repo",
  expiresAt: 60_000,
};
const credential = {
  host: "github.com",
  token: Redacted.make("release-tests"),
  source: "gh" as const,
  fingerprint: "release-tests",
};
const objectUrl = "https://release-assets.githubusercontent.com/object.png?signature=test";
const image = new Uint8Array([137, 80, 78, 71]);
const response = (
  request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  init: ResponseInit,
  body: Uint8Array | null = null,
) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, init)));

describe("GitHub release media", () => {
  it.effect("selects the exact asset and never sends the token to the object host", () => {
    const lookups: GitHubRest.GitHubRestInput[] = [];
    const requests: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
    return Effect.gen(function* () {
      const result = HttpServerResponse.toWeb(yield* githubMediaResponse(asset, {}));
      expect(result.status).toBe(200);
      expect(result.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(yield* Effect.promise(() => result.arrayBuffer()))).toEqual(image);
      expect(lookups).toEqual([
        {
          host: "github.com",
          operation: "getReleaseByTag",
          path: "repos/owner/private/releases/tags/v1%2Btest",
        },
      ]);
      expect(requests.map(({ url }) => url)).toEqual([
        "https://api.github.com/repos/owner/private/releases/assets/42",
        objectUrl,
      ]);
      expect(requests[0]!.headers.authorization).toBe("Bearer release-tests");
      expect(requests[0]!.headers.accept).toBe("application/octet-stream");
      expect(requests[1]!.headers.authorization).toBeUndefined();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(GitHubCredentials.GitHubCredentials)({
            get: () => Effect.succeed(credential),
          }),
          Layer.mock(GitHubRest.GitHubRest)({
            rest: (input) => {
              lookups.push(input);
              return Effect.succeed({
                status: 200,
                headers: {},
                truncated: false,
                invalidUtf8: false,
                body: JSON.stringify({
                  assets: [
                    { id: 41, name: "shot #1%.png.bak" },
                    { id: 42, name: "shot #1%.png", url: "https://untrusted.invalid/ignored" },
                  ],
                }),
              });
            },
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              requests.push({ url: request.url, headers: request.headers });
              if (request.url === "https://api.github.com/repos/owner/private/releases/assets/42") {
                return response(request, { status: 302, headers: { location: objectUrl } });
              }
              if (request.url === objectUrl) {
                return response(
                  request,
                  { status: 200, headers: { "content-type": "application/octet-stream" } },
                  image,
                );
              }
              return response(request, { status: 404 });
            }),
          ),
        ),
      ),
      Effect.scoped,
    );
  });

  it.effect.each(["no credential", "lookup fails"])(
    "loads a public release anonymously when %s",
    (mode) => {
      const requests: Array<{ url: string; authorization: string | undefined }> = [];
      let lookups = 0;
      return Effect.gen(function* () {
        const result = HttpServerResponse.toWeb(yield* githubMediaResponse(asset, {}));
        expect(result.status).toBe(200);
        expect(new Uint8Array(yield* Effect.promise(() => result.arrayBuffer()))).toEqual(image);
        expect(lookups).toBe(mode === "no credential" ? 0 : 1);
        expect(requests).toEqual([
          { url: asset.url, authorization: undefined },
          { url: objectUrl, authorization: undefined },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(GitHubCredentials.GitHubCredentials)({
              get: (host) =>
                mode === "no credential"
                  ? Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }))
                  : Effect.succeed(credential),
            }),
            Layer.mock(GitHubRest.GitHubRest)({
              rest: () => {
                lookups++;
                return Effect.fail(
                  new GitHubRequestPolicy.GitHubApiAuthenticationError({
                    host: "github.com",
                    operation: "getReleaseByTag",
                  }),
                );
              },
            }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                requests.push({ url: request.url, authorization: request.headers.authorization });
                return request.url === asset.url
                  ? response(request, { status: 302, headers: { location: objectUrl } })
                  : response(
                      request,
                      { status: 200, headers: { "content-type": "image/png" } },
                      image,
                    );
              }),
            ),
          ),
        ),
        Effect.scoped,
      );
    },
  );
});

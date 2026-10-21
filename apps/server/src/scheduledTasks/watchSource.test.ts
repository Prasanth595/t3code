import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { readWatchSource, watchSourceUrl } from "./watchSource.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const jira = {
  type: "jira" as const,
  baseUrl: "https://example.atlassian.net",
  jql: "project = TEST",
};
const http = {
  type: "http_json" as const,
  url: "https://example.com/items",
  itemsPath: "data.items",
  keyPath: "id",
};
const response = (request: HttpClientRequest.HttpClientRequest, value: unknown) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response(json(value))));

it.effect("fetches every Jira Cloud GET page before returning a snapshot", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const client = HttpClient.make((request) => {
      requests.push(request);
      return response(
        request,
        requests.length === 1
          ? {
              issues: [{ id: "100", fields: { status: { name: "Ready" } } }],
              isLast: false,
              nextPageToken: "second",
            }
          : { issues: [{ id: "101" }], isLast: true },
      );
    });
    const items = yield* readWatchSource(jira, "Bearer private-token").pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    assert.deepEqual(
      items.map((item) => item.key),
      ["100", "101"],
    );
    assert.equal(requests.length, 2);
    assert.isTrue(
      requests.every(
        (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/rest/api/3/search/jql",
      ),
    );
    assert.equal(new URL(requests[1]!.url).searchParams.get("nextPageToken"), "second");
    assert.equal(requests[0]!.headers.authorization, "Bearer private-token");
  }),
);

it.effect("rejects incomplete or looping Jira pagination", () =>
  Effect.gen(function* () {
    for (const body of [
      { issues: [], isLast: false },
      { issues: [], isLast: false, nextPageToken: "loop" },
      { issues: [] },
    ]) {
      const failure = yield* readWatchSource(jira, undefined).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => response(request, body)),
        ),
        Effect.flip,
      );
      assert.isFalse(failure.message.includes("loop"));
    }
  }),
);

it.effect("rejects malformed Jira pages and duplicate IDs across pages", () =>
  Effect.gen(function* () {
    for (const malformed of [
      "not json",
      '{"issues":{}}',
      '{"issues":[{}],"isLast":true}',
      '{"issues":[{"id":"one"},{"id":"one"}],"isLast":true}',
    ]) {
      yield* readWatchSource(jira, undefined).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(malformed))),
          ),
        ),
        Effect.flip,
      );
    }
    let page = 0;
    yield* readWatchSource(jira, undefined).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          response(
            request,
            ++page === 1
              ? { issues: [{ id: "one" }], nextPageToken: "next", isLast: false }
              : { issues: [{ id: "one" }], isLast: true },
          ),
        ),
      ),
      Effect.flip,
    );
    assert.equal(page, 2);
  }),
);

it.effect("reads a nested HTTP snapshot and rejects duplicate keys and oversized bodies", () =>
  Effect.gen(function* () {
    const items = yield* readWatchSource(http, undefined).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => response(request, { data: { items: [{ id: 1 }] } })),
      ),
    );
    assert.equal(items[0]!.key, "1");
    for (const value of [
      [{ id: 1 }, { id: 1 }],
      [{ id: 1, text: "x".repeat(2 * 1024 * 1024) }],
      [{ name: "missing key" }],
      Array.from({ length: 1001 }, (_, id) => ({ id })),
    ]) {
      yield* readWatchSource(http, undefined).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => response(request, { data: { items: value } })),
        ),
        Effect.flip,
      );
    }
  }),
);

it.effect("rejects redirects and keeps transport errors free of credentials", () =>
  Effect.gen(function* () {
    const failure = yield* readWatchSource(http, "Bearer private-token").pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("private-token", {
                status: 302,
                headers: { location: "https://other.example" },
              }),
            ),
          ),
        ),
      ),
      Effect.flip,
    );
    assert.isFalse(failure.message.includes("private-token"));
  }),
);

it("rejects credentials in source URLs and non-Cloud Jira URLs", () => {
  for (const url of [
    "https://user:password@example.com/items",
    "https://example.com/items?token=private",
    "file:///private/file",
    "https://example.com/items#secret",
  ]) {
    assert.throws(() => watchSourceUrl({ ...http, url }));
  }
  assert.throws(() => watchSourceUrl({ ...jira, baseUrl: "https://jira.example.com" }));
});

it.effect("rejects remote HTTP auth before polling and permits local auth and plain HTTP", () =>
  Effect.gen(function* () {
    const requests: HttpClientRequest.HttpClientRequest[] = [];
    const client = HttpClient.make((request) => {
      requests.push(request);
      return response(request, { data: { items: [] } });
    });
    for (const auth of [
      { type: "bearer" as const, hasSecret: true },
      { type: "basic" as const, username: "alice", hasSecret: true },
    ]) {
      const source = { ...http, url: "http://example.com/items", auth };
      assert.throws(() => watchSourceUrl(source));
      yield* readWatchSource(source, "private-token").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
    }
    yield* readWatchSource(
      { ...http, url: "http://example.com/items" },
      "Bearer private-token",
    ).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);
    assert.equal(requests.length, 0);
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      yield* readWatchSource(
        { ...http, url: `http://${host}/items`, auth: { type: "bearer", hasSecret: true } },
        "Bearer local-token",
      ).pipe(Effect.provideService(HttpClient.HttpClient, client));
      assert.equal(requests.at(-1)!.headers.authorization, "Bearer local-token");
    }
    yield* readWatchSource({ ...http, url: "http://example.com/items" }, undefined).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    assert.equal(requests.length, 4);
  }),
);

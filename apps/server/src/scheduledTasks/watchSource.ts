import {
  ScheduledTaskError,
  type ScheduledTaskWatchInput,
  type ScheduledTaskWatchSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { redactQuery } from "./webhookTemplate.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 1_000;
const MAX_PAGES = 20;
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const sourceError = () =>
  new ScheduledTaskError({
    message: "The watcher source did not return a complete, valid snapshot within its limits.",
  });

export function watchValue(item: unknown, path: string): unknown {
  let value = item;
  if (path === "") return value;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function watchSourceUrl(
  source: ScheduledTaskWatchSource | ScheduledTaskWatchInput["source"],
  hasAuthorization = false,
): URL {
  const url = new URL(source.type === "jira" ? source.baseUrl : source.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    redactQuery(url.search.slice(1)) !== url.search.slice(1)
  )
    throw sourceError();
  if (
    source.type === "jira" &&
    (url.protocol !== "https:" ||
      url.search ||
      url.port ||
      !(
        (url.hostname.endsWith(".atlassian.net") && /^\/?$/.test(url.pathname)) ||
        (url.hostname === "api.atlassian.com" &&
          /^\/ex\/jira\/[a-zA-Z0-9-]+\/?$/.test(url.pathname))
      ))
  )
    throw sourceError();
  if (
    (source.auth !== undefined || hasAuthorization) &&
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw sourceError();
  return url;
}

export const readWatchSource = Effect.fn("ScheduledTaskService.readWatchSource")(
  function* (source: ScheduledTaskWatchSource, authorization: string | undefined) {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const base = yield* Effect.try({
      try: () => watchSourceUrl(source, authorization !== undefined),
      catch: sourceError,
    });
    const items: { key: string; value: unknown }[] = [];
    const keys = new Set<string>();
    const tokens = new Set<string>();
    let token: string | undefined;
    let bytes = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(base);
      if (source.type === "jira") {
        url.pathname = `${url.pathname.replace(/\/$/, "")}/rest/api/3/search/jql`;
        url.searchParams.set("jql", source.jql);
        url.searchParams.set("maxResults", "100");
        url.searchParams.set("fields", "*all");
        url.searchParams.set("failFast", "true");
        if (token !== undefined) url.searchParams.set("nextPageToken", token);
      }
      const response = yield* client
        .execute(
          HttpClientRequest.get(url.toString()).pipe(
            HttpClientRequest.setHeaders({
              accept: "application/json",
              ...(authorization === undefined ? {} : { authorization }),
            }),
          ),
        )
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      if (response.status !== 200) return yield* sourceError();
      const chunks = yield* response.stream.pipe(
        Stream.runFoldEffect(
          () => [] as Uint8Array[],
          (chunks, chunk) => {
            bytes += chunk.byteLength;
            if (bytes > MAX_BYTES) return Effect.fail(sourceError());
            chunks.push(chunk);
            return Effect.succeed(chunks);
          },
        ),
      );
      const body = yield* decodeJson(Buffer.concat(chunks).toString("utf8"));
      const values = watchValue(body, source.type === "jira" ? "issues" : source.itemsPath);
      if (!Array.isArray(values) || items.length + values.length > MAX_ITEMS)
        return yield* sourceError();
      for (const value of values) {
        const key = watchValue(value, source.type === "jira" ? "id" : source.keyPath);
        if (
          (typeof key !== "string" && typeof key !== "number") ||
          String(key) === "" ||
          String(key).length > 512 ||
          keys.has(String(key))
        )
          return yield* sourceError();
        keys.add(String(key));
        items.push({ key: String(key), value });
      }
      if (source.type === "http_json") return items;
      if (watchValue(body, "isLast") === true) return items;
      const next = watchValue(body, "nextPageToken");
      if (typeof next !== "string" || next === "" || next.length > 8192 || tokens.has(next))
        return yield* sourceError();
      tokens.add(next);
      token = next;
    }
    return yield* sourceError();
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeout("30 seconds"),
      Effect.mapError(() => sourceError()),
    ),
);

import * as Mime from "effect/http/Mime";
import {
  githubMediaFileName,
  githubMediaFetchUrl,
  githubMarkdownRepository,
} from "@t3tools/shared/githubMedia";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { ResolvedAsset } from "./AssetAccess.ts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
  type HttpClientResponse,
} from "effect/http";

import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";

/**
 * Everything a redirect leads to — the presigned object stores GitHub hands assets off to —
 * authorizes with its own signature, and some of them reject a request that also carries a
 * bearer token.
 */
const CREDENTIALED_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "media.githubusercontent.com",
]);
const isCredentialedHost = (url: string) => {
  try {
    return CREDENTIALED_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

const MAX_REDIRECTS = 3;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const FORWARDED_REQUEST_HEADERS = ["range", "if-range"] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;
const MEDIA_CONTENT_TYPE_PATTERN = /^(?:image|video|audio)\/[\w!#$&^.+-]+$/i;
const SVG_CONTENT_TYPE = "image/svg+xml";
// An SVG is a document: same policy the asset route gives a workspace SVG, so one embedded in a
// body cannot run script against this origin.
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const githubToken = GitHubCredentials.GitHubCredentials.pipe(
  Effect.flatMap((credentials) => credentials.get("github.com")),
  Effect.map((credential) => credential.token),
  Effect.orElseSucceed(() => null),
);

const fetchFollowingRedirects = Effect.fn("GitHubMediaFetch.fetchFollowingRedirects")(function* (
  url: string,
  headers: Record<string, string>,
  token: Redacted.Redacted | null,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  let target = url;
  for (let hop = 0; ; hop += 1) {
    const authorization =
      token !== null && isCredentialedHost(target) ? `Bearer ${Redacted.value(token)}` : null;
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
    const release = Scope.close(scope, Exit.void);
    const response: HttpClientResponse.HttpClientResponse = yield* httpClient
      .execute(
        HttpClientRequest.get(target).pipe(
          HttpClientRequest.setHeaders({
            ...headers,
            // The bytes are streamed straight through, so never let an encoding layer in.
            "accept-encoding": "identity",
            ...(authorization === null ? {} : { authorization }),
          }),
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(Scope.Scope, scope),
      );
    const location = response.headers.location;
    if (response.status < 300 || response.status >= 400) return { response, release };
    yield* release;
    if (!location || hop >= MAX_REDIRECTS) return null;
    const next = new URL(location, target);
    if (next.protocol !== "https:") return null;
    target = next.toString();
  }
});

function signedMediaSource(html: string): string | null {
  const image = /<img\b[^>]*>/i.exec(html)?.[0];
  const source = image && /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(image);
  const attribute = source?.[1] ?? source?.[2];
  if (!attribute) return null;
  const entities: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  const decoded = attribute.replace(
    /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi,
    (entity, name: string) => {
      if (!name.startsWith("#")) return entities[name.toLowerCase()] ?? entity;
      const code =
        name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    },
  );
  try {
    const url = new URL(decoded);
    return url.protocol === "https:" &&
      url.hostname === "private-user-images.githubusercontent.com" &&
      url.username === "" &&
      url.password === "" &&
      url.port === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const resolveAttachment = Effect.fn("GitHubMediaFetch.resolveAttachment")(function* (
  url: string,
  context: string,
) {
  const github = yield* GitHubRest.GitHubRest;
  const rendered = yield* github.rest({
    host: "github.com",
    operation: "resolve pull request attachment",
    method: "POST",
    path: "markdown",
    body: { mode: "gfm", text: `![](<${url}>)`, context },
    maxResponseBytes: 64 * 1024,
  });
  return rendered.truncated || rendered.invalidUtf8 ? null : signedMediaSource(rendered.body);
});

export const githubMediaResponse = Effect.fn("GitHubMediaFetch.githubMediaResponse")(function* (
  asset: Omit<Extract<ResolvedAsset, { kind: "github-media" }>, "kind">,
  requestHeaders: Record<string, string | undefined>,
) {
  // Both media hosts are served by github.com's account, which is the host `gh` stores it under.
  const token = yield* githubToken;
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = requestHeaders[name];
    if (value !== undefined) forwarded[name] = value;
  }
  let fetched = yield* fetchFollowingRedirects(asset.url, forwarded, token);
  const context =
    asset.repositoryUrl === undefined ? null : githubMarkdownRepository(asset.repositoryUrl);
  const canonical = githubMediaFetchUrl(asset.url);
  const attachment = canonical !== null && new URL(canonical).hostname === "github.com";
  if (
    fetched &&
    context &&
    attachment &&
    ([401, 403, 404].includes(fetched.response.status) ||
      (fetched.response.status >= 200 &&
        fetched.response.status < 300 &&
        /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(
          fetched.response.headers["content-type"] ?? "",
        )))
  ) {
    yield* fetched.release;
    const signed = yield* resolveAttachment(canonical, context).pipe(
      Effect.orElseSucceed(() => null),
    );
    fetched =
      signed === null
        ? null
        : yield* fetchFollowingRedirects(signed, forwarded, null).pipe(
            Effect.orElseSucceed(() => null),
          );
  }
  const response = fetched?.response ?? null;
  const remainingSeconds = Math.floor((asset.expiresAt - (yield* Clock.currentTimeMillis)) / 1000);
  const headers: Record<string, string> = {
    "cache-control":
      remainingSeconds > 0 ? `private, max-age=${remainingSeconds}` : "private, no-store",
    "x-content-type-options": "nosniff",
  };
  if (response === null) return HttpServerResponse.empty({ status: 502, headers });
  // It carries none of the upstream entity headers: a `content-length` with no body behind it
  // holds the connection open until the browser gives up on it.
  if (response.status >= 400) {
    return HttpServerResponse.empty({
      status: response.status >= 500 ? 502 : response.status,
      headers,
    });
  }
  const upstreamType =
    response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const contentType =
    upstreamType === "text/html" || upstreamType === "application/xhtml+xml"
      ? ""
      : MEDIA_CONTENT_TYPE_PATTERN.test(upstreamType)
        ? upstreamType
        : Option.getOrElse(Mime.getType(githubMediaFileName(asset.url)), () => "").toLowerCase();
  if (!MEDIA_CONTENT_TYPE_PATTERN.test(contentType)) {
    return HttpServerResponse.empty({ status: 415, headers });
  }
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  headers["content-type"] = contentType;
  if (contentType === SVG_CONTENT_TYPE) {
    headers["content-security-policy"] = SVG_CONTENT_SECURITY_POLICY;
  }
  return HttpServerResponse.stream(
    response.stream.pipe(Stream.mapError(() => new Error("GitHub media stream failed."))),
    {
      status: response.status,
      headers,
      contentType,
    },
  );
});

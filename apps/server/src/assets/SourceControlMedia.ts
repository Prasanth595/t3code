import * as Mime from "effect/http/Mime";
import { githubMediaFileName } from "@t3tools/shared/githubMedia";
import {
  gitlabMediaFileName,
  gitlabUploadApiUrl,
  parseGitLabUpload,
} from "@t3tools/shared/gitlabMedia";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
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
import * as GitLabCredentials from "@t3tools/source-control-gitlab/server/GitLabCredentials";

/**
 * Exactly the hosts the credential is for. Everything a redirect leads to — the presigned
 * object stores GitHub hands assets off to — authorizes with its own signature, and some of
 * them reject a request that also carries a bearer token.
 */
const GITHUB_CREDENTIALED_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "media.githubusercontent.com",
]);
const isGitHubCredentialedUrl = (url: string) => {
  try {
    return GITHUB_CREDENTIALED_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

/** Hosts answer an asset request with a 302 to a signed object URL that needs no credential. */
const MAX_REDIRECTS = 3;
/** Following the redirect here, rather than in `fetch`, is what keeps the token on the host. */
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
/** Passed through so a seek in a long video costs one upstream range request, not a full download. */
const FORWARDED_REQUEST_HEADERS = ["range", "if-range"] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;
/** A pull request embeds pictures and recordings. Anything else is not served from our origin. */
const MEDIA_CONTENT_TYPE_PATTERN = /^(?:image|video|audio)\/[\w!#$&^.+-]+$/i;
const SVG_CONTENT_TYPE = "image/svg+xml";
// An SVG is a document: same policy the asset route gives a workspace SVG, so one embedded in a
// body cannot run script against this origin.
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

interface Credential {
  readonly authorization: string;
  /** Whether a request to `url` may carry the credential. */
  readonly appliesTo: (url: string) => boolean;
}

/**
 * The github.com credential, or null without one: a public asset still loads, and a private one
 * fails the way it does in a browser that is not signed in.
 */
const githubCredential = GitHubCredentials.GitHubCredentials.pipe(
  Effect.flatMap((credentials) => credentials.get("github.com")),
  Effect.map((credential): Credential => ({
    authorization: `Bearer ${Redacted.value(credential.token)}`,
    appliesTo: isGitHubCredentialedUrl,
  })),
  Effect.orElseSucceed(() => null),
);

/**
 * Follows the host's redirect to the signed object itself, and never carries the credential off
 * the host: the object URL authorizes with its own signature, and the store it lives in has no
 * business seeing a token.
 */
const fetchFollowingRedirects = Effect.fn("SourceControlMedia.fetchFollowingRedirects")(function* (
  url: string,
  requestHeaders: Record<string, string | undefined>,
  credential: Credential | null,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = requestHeaders[name];
    if (value !== undefined) headers[name] = value;
  }
  let target = url;
  for (let hop = 0; ; hop += 1) {
    // Deciding from the target, not from the hop count, is what keeps the credential on the host.
    const authorization =
      credential !== null && credential.appliesTo(target) ? credential.authorization : null;
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
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT));
    const location = response.headers.location;
    if (response.status < 300 || response.status >= 400) return response;
    // A chain this long is not the host answering with bytes, and its body is not the media.
    if (!location || hop >= MAX_REDIRECTS) return null;
    const next = new URL(location, target);
    if (next.protocol !== "https:") return null;
    target = next.toString();
  }
});

/**
 * An upload the host serves never changes under its URL, so the only thing a cached copy must
 * not outlive is the signed URL that granted it — which is the same bound the URL itself has.
 */
const cacheHeaders = (expiresAt: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now): Record<string, string> => {
      const remainingSeconds = Math.floor((expiresAt - now) / 1000);
      return {
        "cache-control":
          remainingSeconds > 0 ? `private, max-age=${remainingSeconds}` : "private, no-store",
        "x-content-type-options": "nosniff",
      };
    }),
  );

/** Streams an upstream answer back, but only pictures and recordings. */
function mediaResponse(
  response: HttpClientResponse.HttpClientResponse,
  fileName: string,
  headers: Record<string, string>,
) {
  // An upstream refusal is the client's answer, not this server's fault; only a broken hop is.
  // It carries none of the upstream entity headers: a `content-length` with no body behind it
  // holds the connection open until the browser gives up on it.
  if (response.status >= 400) {
    return HttpServerResponse.empty({
      status: response.status >= 500 ? 502 : response.status,
      headers,
    });
  }
  // Never on the host's word alone: GitHub's raw host and GitLab's upload API label every
  // binary `application/octet-stream`, so the name decides those.
  const upstreamType =
    response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const contentType = MEDIA_CONTENT_TYPE_PATTERN.test(upstreamType)
    ? upstreamType
    : Option.getOrElse(Mime.getType(fileName), () => "").toLowerCase();
  if (!MEDIA_CONTENT_TYPE_PATTERN.test(contentType)) {
    return HttpServerResponse.empty({ status: 415, headers });
  }
  const streamed = { ...headers };
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers[name];
    if (value !== undefined) streamed[name] = value;
  }
  streamed["content-type"] = contentType;
  if (contentType === SVG_CONTENT_TYPE) {
    streamed["content-security-policy"] = SVG_CONTENT_SECURITY_POLICY;
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: streamed,
    contentType,
  });
}

/**
 * Serves media a pull request body points at on GitHub through the `gh` credential, which is the
 * only thing that distinguishes a readable private attachment from a 404.
 */
export const githubMediaResponse = Effect.fn("SourceControlMedia.githubMediaResponse")(function* (
  asset: { readonly url: string; readonly cwd: string; readonly expiresAt: number },
  requestHeaders: Record<string, string | undefined>,
) {
  // Both media hosts are served by github.com's account, which is the host `gh` stores it under.
  const credential = yield* githubCredential;
  const response = yield* fetchFollowingRedirects(asset.url, requestHeaders, credential);
  const headers = yield* cacheHeaders(asset.expiresAt);
  if (response === null) return HttpServerResponse.empty({ status: 502, headers });
  return mediaResponse(response, githubMediaFileName(asset.url), headers);
});

/**
 * Serves a GitLab upload through the upload API with the `glab` login for its host. Whatever
 * that cannot serve (no login, GitLab before 17.4) redirects to the upload itself, which is
 * what loaded before and still works for a public project.
 */
export const gitlabMediaResponse = Effect.fn("SourceControlMedia.gitlabMediaResponse")(function* (
  asset: { readonly url: string; readonly expiresAt: number },
  requestHeaders: Record<string, string | undefined>,
) {
  const original = HttpServerResponse.redirect(asset.url, {
    status: 302,
    headers: { "cache-control": "private, no-store" },
  });
  const upload = parseGitLabUpload(asset.url);
  if (upload === null) return original;
  const credentials = yield* GitLabCredentials.GitLabCredentials;
  const token = yield* credentials.get(upload.host);
  if (Option.isNone(token)) return original;
  const response = yield* fetchFollowingRedirects(gitlabUploadApiUrl(upload), requestHeaders, {
    authorization: `Bearer ${Redacted.value(token.value)}`,
    appliesTo: (url) => URL.canParse(url) && new URL(url).origin === upload.origin,
  });
  if (response?.status === 401) yield* credentials.invalidate(upload.host);
  if (response === null || [401, 403, 404].includes(response.status)) return original;
  return mediaResponse(
    response,
    gitlabMediaFileName(asset.url),
    yield* cacheHeaders(asset.expiresAt),
  );
});

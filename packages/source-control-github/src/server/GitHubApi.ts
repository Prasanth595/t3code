import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import { queryHash } from "./gitHubGraphQlClient.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const { gitHubApiUrls, normalizeHost } = GitHubRequestPolicy;
type GitHubApiError = GitHubRequestPolicy.GitHubApiError;

export interface GitHubRestResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly truncated: boolean;
  /** The body was not valid UTF-8, which a raw file read takes to mean binary. */
  readonly invalidUtf8: boolean;
}

export interface GitHubRestInput {
  readonly host: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Relative to the API root, e.g. `repos/acme/web/pulls/7`; query string included. */
  readonly path: string;
  readonly body?: unknown;
  /** Defaults to `application/vnd.github+json`. */
  readonly accept?: string;
  /** Revalidates a cached answer. A 304 is returned rather than failed, and is free. */
  readonly ifNoneMatch?: string;
  readonly maxResponseBytes?: number;
  /** Defaults to 30 seconds; a whole pull request's patch may need longer. */
  readonly timeout?: Duration.Input;
  /** Overrides `SourceControlRateLimit.Interactive` for this one request. */
  readonly allowReserve?: boolean;
}

export interface GitHubGraphQlInput {
  readonly host: string;
  readonly operation: string;
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly allowReserve?: boolean;
  readonly maxResponseBytes?: number;
}

export class GitHubApi extends Context.Service<
  GitHubApi,
  {
    /** The raw JSON body of a successful GraphQL answer, with `rateLimit` recorded. */
    readonly graphql: (input: GitHubGraphQlInput) => Effect.Effect<string, GitHubApiError>;
    readonly rest: (input: GitHubRestInput) => Effect.Effect<GitHubRestResponse, GitHubApiError>;
    /** The credential a request to `host` would carry right now. */
    readonly credential: (
      host: string,
    ) => Effect.Effect<
      { readonly token: Redacted.Redacted<string>; readonly fingerprint: string },
      GitHubApiError
    >;
  }
>()("@t3tools/source-control-github/server/GitHubApi") {}

/** GraphQL documents longer than this are cut in traces; the hash still identifies them. */
const TRACED_QUERY_MAX_CHARS = 4_000;

const decodeGraphQlErrors = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      errors: Schema.NonEmptyArray(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          message: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

/** A REST failure body: `{ message, errors: [{ message } | { resource, field, code }] }`. */
const decodeRestErrors = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      errors: Schema.optional(
        Schema.Array(
          Schema.Union([
            Schema.String,
            Schema.Struct({
              message: Schema.optional(Schema.String),
              field: Schema.optional(Schema.String),
              code: Schema.optional(Schema.String),
            }),
          ]),
        ),
      ),
    }),
  ),
);

function restErrorMessages(body: string): ReadonlyArray<string> | undefined {
  return Option.match(decodeRestErrors(body), {
    onNone: () => undefined,
    onSome: (decoded) => {
      const details = (decoded.errors ?? []).flatMap((error) =>
        typeof error === "string"
          ? [error]
          : error.message !== undefined
            ? [error.message]
            : error.field !== undefined && error.code !== undefined
              ? [`${error.field} ${error.code}`]
              : [],
      );
      const messages = [...(decoded.message === undefined ? [] : [decoded.message]), ...details];
      return messages.length > 0 ? messages : undefined;
    },
  });
}

/**
 * GitHub reports a failed GraphQL document with HTTP 200 and an `errors` list, so a GraphQL body
 * is read for its error types as well as its status. `gh api graphql` failed those too, and
 * callers rely on that to fall back to narrower reads.
 */
function classify(input: {
  readonly answer: GitHubRestResponse;
  readonly graphql: boolean;
  readonly acceptNotModified: boolean;
}): GitHubRequestPolicy.GitHubAnswer<GitHubRestResponse> {
  const { status, headers, body } = input.answer;
  const meta = { status, headers };
  const errors = input.graphql
    ? Option.getOrUndefined(decodeGraphQlErrors(body))?.errors
    : undefined;
  const messages = errors?.flatMap((error) => (error.message === undefined ? [] : [error.message]));
  if (
    GitHubRequestPolicy.isRateLimited({
      status,
      headers,
      body,
      ...(errors === undefined ? {} : { graphqlErrors: errors }),
    })
  ) {
    return { _tag: "RateLimited", ...meta };
  }
  if (status === 401) return { _tag: "Unauthorized", ...meta };
  if (
    status === 404 ||
    (errors !== undefined && errors.every((error) => error.type === "NOT_FOUND"))
  ) {
    return { _tag: "NotFound", ...meta };
  }
  if (errors !== undefined) return { _tag: "Failed", messages, ...meta };
  if ((status >= 200 && status < 300) || (status === 304 && input.acceptNotModified)) {
    return { _tag: "Ok", value: input.answer, ...meta };
  }
  return {
    _tag: "Failed",
    messages: input.graphql ? undefined : restErrorMessages(body),
    ...meta,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy;

  /**
   * Sends one request through the request policy and fails a refusal with the error that says
   * why. The answer is returned only once it is known to be one.
   */
  const send = Effect.fn("GitHubApi.send")(function* (input: {
    readonly host: string;
    readonly operation: string;
    readonly request: HttpClientRequest.HttpClientRequest;
    readonly maxResponseBytes: number;
    readonly timeout?: Duration.Input | undefined;
    readonly allowReserve: boolean;
    readonly acceptNotModified: boolean;
    /** Reads the body for GraphQL `errors`, which GitHub sends with HTTP 200. */
    readonly graphql?: boolean;
  }) {
    const host = normalizeHost(input.host);
    // Only the path: a query string can carry a SHA or a branch, and never needs to be in a trace.
    yield* Effect.annotateCurrentSpan({
      "github.kind": input.graphql === true ? "graphql" : "rest",
      "http.request.method": input.request.method,
      "url.path": new URL(input.request.url).pathname,
    });
    return yield* policy.request(
      {
        host,
        operation: input.operation,
        // REST spends `core` and GraphQL its own quota, each with its own reserve. Every REST
        // path this reads today is `core`; a `search/` read would need its own resource here.
        resource: input.graphql === true ? "graphql" : "core",
        allowReserve: input.allowReserve,
        timeout: input.timeout,
      },
      (headers) =>
        Effect.gen(function* () {
          const response: HttpClientResponse.HttpClientResponse = yield* httpClient
            .execute(input.request.pipe(HttpClientRequest.setHeaders(headers)))
            .pipe(
              // `GitHubApi.send` is the request's span. The client's own span would add
              // `url.full` and `url.query`, which can carry SHAs and branch names, so it is off.
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            );
          const collected = yield* collectUint8StreamText({
            stream: response.stream,
            maxBytes: input.maxResponseBytes,
          }).pipe(
            // 204, 304 and many refusals carry no body at all, which is an empty answer.
            Effect.catchIf(
              (error) => error.reason._tag === "EmptyBodyError",
              () => Effect.succeed({ text: "", truncated: false, invalidUtf8: false }),
            ),
          );
          const { status, headers: responseHeaders } = response;
          const answer = {
            status,
            headers: responseHeaders,
            body: collected.text,
            truncated: collected.truncated,
            invalidUtf8: collected.invalidUtf8,
          };
          return classify({
            answer,
            graphql: input.graphql === true,
            acceptNotModified: input.acceptNotModified,
          });
        }).pipe(
          Effect.mapError(
            (cause) =>
              new GitHubRequestPolicy.GitHubApiRequestError({
                host,
                operation: input.operation,
                cause,
              }),
          ),
        ),
    );
  });

  const rest: GitHubApi["Service"]["rest"] = (input) => {
    const url = `${gitHubApiUrls(input.host).rest}/${input.path.replace(/^\/+/, "")}`;
    const base = HttpClientRequest.make(input.method ?? "GET")(url).pipe(
      HttpClientRequest.setHeader("accept", input.accept ?? "application/vnd.github+json"),
    );
    const withEtag =
      input.ifNoneMatch === undefined
        ? base
        : base.pipe(HttpClientRequest.setHeader("if-none-match", input.ifNoneMatch));
    const request =
      input.body === undefined
        ? withEtag
        : withEtag.pipe(HttpClientRequest.bodyJsonUnsafe(input.body));
    return SourceControlRateLimit.Interactive.pipe(
      Effect.flatMap((interactive) =>
        send({
          host: input.host,
          operation: input.operation,
          request,
          maxResponseBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
          timeout: input.timeout,
          allowReserve: input.allowReserve ?? interactive,
          acceptNotModified: input.ifNoneMatch !== undefined,
        }),
      ),
    );
  };

  const graphql: GitHubApi["Service"]["graphql"] = Effect.fn("GitHubApi.graphql")(
    function* (input) {
      const host = normalizeHost(input.host);
      const allowReserve = input.allowReserve ?? (yield* SourceControlRateLimit.Interactive);
      // The document, never its variables: user text (bodies, search terms) travels as variables.
      yield* Effect.annotateCurrentSpan({
        "github.operation": input.operation,
        "github.graphql.query_hash": queryHash(input.query),
        "github.graphql.query":
          input.query.length > TRACED_QUERY_MAX_CHARS
            ? `${input.query.slice(0, TRACED_QUERY_MAX_CHARS)}…`
            : input.query,
      });
      const response = yield* send({
        host,
        operation: input.operation,
        request: HttpClientRequest.post(gitHubApiUrls(host).graphql).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe({
            query: input.query,
            variables: input.variables ?? {},
          }),
        ),
        maxResponseBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        allowReserve,
        acceptNotModified: false,
        graphql: true,
      });
      // A body cut at the byte cap hides any `errors` past the cut and cannot be decoded.
      if (response.truncated) {
        return yield* new GitHubRequestPolicy.GitHubApiResponseError({
          host,
          operation: input.operation,
          status: response.status,
        });
      }
      return response.body;
    },
  );

  return GitHubApi.of({ graphql, rest, credential: policy.credential });
});

/**
 * The REST transport together with the request policy it sends through, which the GraphQL
 * client sends through too, so both share one set of request slots.
 */
export const layer = Layer.effect(GitHubApi, make).pipe(
  Layer.provideMerge(GitHubRequestPolicy.layer),
);

/**
 * The transports with the credential, quota reserve and rate-limit pause they read through. An
 * application builds this once so every GitHub reader shares one view of each quota per host.
 */
export const layerWithDependencies = layer.pipe(
  Layer.provideMerge(GitHubCredentials.layer),
  Layer.provideMerge(GitHubQuota.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
);

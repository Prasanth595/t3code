import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { GraphQLMiddleware, GraphQLProtocol } from "effect/graphql";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as GitHubApi from "./GitHubApi.ts";

/**
 * The GitHub host and operation a generated GraphQL call is sent as. One client serves every host,
 * so each call names its own, as `GitHubApi.graphql` takes them as arguments.
 */
export class GitHubGraphQlTarget extends Context.Service<
  GitHubGraphQlTarget,
  {
    readonly host: string;
    readonly operation: string;
    readonly allowReserve?: boolean | undefined;
  }
>()("@t3tools/source-control-github/server/gitHubGraphQlClient/GitHubGraphQlTarget") {}

const decodeExecutionResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GraphQLProtocol.ExecutionResult),
);

/**
 * Sends generated operations through `GitHubApi`, which holds the credential, the quota reserve and
 * the host-wide rate-limit pause, so a call fails with the same errors as any other GitHub read.
 *
 * Answers come back partial: an `errors` entry that names one alias of a batch fails only that
 * pull request, which `GraphQLResolver.aliased` settles per slice. A rate limit, a refused
 * credential or an HTTP failure still fails the whole request.
 */
export class GitHubGraphQlTransport extends GraphQLMiddleware.Service<
  GitHubGraphQlTransport,
  { requires: GitHubGraphQlTarget; error: GitHubApi.GitHubApiError }
>()("@t3tools/source-control-github/server/gitHubGraphQlClient/GitHubGraphQlTransport") {
  static readonly layer = Layer.effect(
    GitHubGraphQlTransport,
    Effect.gen(function* () {
      const api = yield* GitHubApi.GitHubApi;
      return {
        execute: ({ request }) =>
          Effect.gen(function* () {
            const target = yield* GitHubGraphQlTarget;
            const body = yield* api.graphql({
              host: target.host,
              operation: target.operation,
              query: request.query,
              variables: request.variables as Readonly<Record<string, unknown>>,
              partial: true,
              ...(target.allowReserve === undefined ? {} : { allowReserve: target.allowReserve }),
            });
            return yield* decodeExecutionResult(body).pipe(
              Effect.mapError(
                () =>
                  new GitHubApi.GitHubApiResponseError({
                    host: target.host,
                    operation: target.operation,
                    status: 200,
                  }),
              ),
            );
          }),
        subscribe: () => Stream.die(new Error("GitHub GraphQL has no subscriptions.")),
      };
    }),
  );
}

/** The transport is the middleware above; a request that got past it would be a wiring bug. */
const layerProtocol = Layer.succeed(GraphQLProtocol.GraphQLProtocol, {
  execute: (request) =>
    Effect.die(new Error(`GitHub GraphQL ${request.operationName} bypassed GitHubApi.`)),
  subscribe: () => Stream.die(new Error("GitHub GraphQL has no subscriptions.")),
});

/**
 * What decides which lookups may share one batched request: the host, and the credential and
 * rate-limit scope `GitHubApi` will send it under. Read from the context the lookup was made in.
 */
export const batchKey = (context: Context.Context<GitHubGraphQlTarget>) =>
  JSON.stringify([
    Context.get(context, GitHubGraphQlTarget).host.toLowerCase(),
    Context.getOrElse(context, GitHubApi.PinnedGitHubCredential, () => null)
      ?.credentialFingerprint ?? null,
    Context.getOrElse(context, SourceControlRateLimit.CredentialScope, () => ""),
  ]);

/** What a client built over `.middleware(GitHubGraphQlTransport)` needs, beyond `GitHubApi`. */
export const layer = Layer.merge(GitHubGraphQlTransport.layer, layerProtocol);

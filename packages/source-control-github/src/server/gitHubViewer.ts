import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GraphQLClient, GraphQLClientError, GraphQLGroup } from "effect/graphql";

import * as GitHubRest from "./GitHubRest.ts";

import * as GitHubGraphQlClient from "./gitHubGraphQlClient.ts";
import { GitHubViewer } from "./gitHubViewer.graphql.ts";

export class GitHubViewerResponseError extends Schema.TaggedError<GitHubViewerResponseError>()(
  "GitHubViewerResponseError",
  { host: Schema.String, operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "GitHub returned an invalid authenticated viewer identity.";
  }
}

const group = GraphQLGroup.make(GitHubViewer).middleware(GitHubGraphQlClient.GitHubGraphQlAuth);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** REST rejects installation tokens; GraphQL verifies their bot using the same credential. */
export const makeGitHubViewerReader = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  const client = yield* GraphQLClient.make(group).pipe(Effect.provide(GitHubGraphQlClient.layer));
  return (input: {
    readonly host: string;
    readonly operation: string;
    readonly allowReserve?: boolean;
  }) =>
    api.rest({ ...input, path: "user" }).pipe(
      Effect.map((response) => response.body),
      Effect.catchIf(
        (error) => error._tag === "GitHubApiResponseError" && error.status === 403,
        () =>
          client.GitHubViewer({}).pipe(
            GitHubGraphQlClient.call(input),
            Effect.map((result) =>
              encodeJson({ id: result.viewer.databaseId, login: result.viewer.login }),
            ),
            Effect.catchIf(GraphQLClientError.isGraphQLClientError, (cause) =>
              Effect.fail(
                new GitHubViewerResponseError({
                  host: input.host,
                  operation: input.operation,
                  cause,
                }),
              ),
            ),
          ),
      ),
    );
});

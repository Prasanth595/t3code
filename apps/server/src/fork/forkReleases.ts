/**
 * Fork: the fork releases that a server can install. The upstream updater reads
 * `SHA256SUMS` of a release, and .github/workflows/fork-release.yml uploads it
 * last, so only a release with it is installable.
 */
import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
    assets: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
);
type ReleaseIndex = typeof ReleaseIndex.Type;

const RELEASE_INDEX_TIMEOUT = Duration.seconds(30);

export class ForkReleaseLookupError extends Schema.TaggedError<ForkReleaseLookupError>()(
  "ForkReleaseLookupError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not list the fork releases.";
  }
}

/**
 * The installable releases of the newest index page, newest first. A release
 * builds on each push, so the page holds the last 100 pushes. An older version
 * is not listed; revisit this if a server must install a version that old.
 */
const installableReleases = (httpClient: HttpClient.HttpClient) =>
  httpClient
    .execute(
      HttpClientRequest.get(cliReleaseIndexPageUrl(1)).pipe(
        HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ReleaseIndex)),
      Effect.timeout(RELEASE_INDEX_TIMEOUT),
      Effect.map((releases): ReleaseIndex =>
        releases.filter((release) =>
          release.assets.some((asset) => asset.name === CLI_RELEASE_CHECKSUMS_FILE),
        ),
      ),
      Effect.mapError((cause) => new ForkReleaseLookupError({ cause })),
    );

const newerIn = (releases: ReleaseIndex, currentVersion: string) => {
  const newest = newestCliReleaseVersion(releases, cliReleaseChannelOf(currentVersion));
  return newest !== undefined && compareExactServiceVersions(newest, currentVersion) > 0
    ? newest
    : undefined;
};

/** The newest installable fork release on the channel of `currentVersion`, if it is newer. */
export const newerForkRelease = (httpClient: HttpClient.HttpClient, currentVersion: string) =>
  installableReleases(httpClient).pipe(Effect.map((releases) => newerIn(releases, currentVersion)));

/**
 * The version that a self-update request installs. A requested version
 * without an installable fork release, for example an upstream version from
 * the store mobile app, installs the newest newer fork release instead. Any
 * other case keeps the requested version, and the upstream updater reports
 * its own error.
 */
export const forkUpdateTarget = (
  httpClient: HttpClient.HttpClient,
  requestedVersion: string,
  currentVersion: string,
) =>
  installableReleases(httpClient).pipe(
    Effect.map((releases) =>
      releases.some((release) => release.tag_name === `v${requestedVersion}`)
        ? requestedVersion
        : (newerIn(releases, currentVersion) ?? requestedVersion),
    ),
    Effect.orElseSucceed(() => requestedVersion),
  );

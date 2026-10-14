import { useAtomValue } from "@effect/atom-react";
import { CLI_RELEASE_CHECKSUMS_FILE, CLI_RELEASE_REPOSITORY } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

const ReleaseAssets = Schema.Struct({
  assets: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const decodeReleaseAssets = Schema.decodeUnknownEffect(ReleaseAssets);

/**
 * Fork replacement for the npm check in npmRelease.ts: whether the fork
 * release `v<version>` can install on a server. The release workflow uploads
 * the checksum file last, after every server archive, so a release without it
 * is not ready. A 404 is false; network and API errors stay unknown. Both
 * re-check every few minutes.
 */
const forkReleaseInstallableAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      const response = yield* HttpClient.get(
        `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases/tags/v${encodeURIComponent(version)}`,
      );
      if (response.status === 404) return false;
      const release = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
        Effect.flatMap(decodeReleaseAssets),
      );
      return release.assets.some((asset) => asset.name === CLI_RELEASE_CHECKSUMS_FILE);
    }).pipe(
      // Tracing headers would make the browser send a CORS preflight.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`fork-release-installable:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("fork-release-installable:none"),
);

/** True only once the fork release of `version` has its checksum file. */
export function useForkReleaseInstallable(version: string | null): boolean {
  const result = useAtomValue(version ? forkReleaseInstallableAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}

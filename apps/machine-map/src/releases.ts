/**
 * The newest nightly of the fork for the install step of the join dialog (MM-211). Fork Release
 * publishes only pre-releases, and GitHub `releases/latest` skips them, so this reads the list.
 * Fork Release uploads `SHA256SUMS` last, so a release with it has every installer, like the
 * releases that a server installs (apps/server/src/fork/forkReleases.ts).
 */
import { CLI_RELEASE_CHECKSUMS_FILE } from "@t3tools/shared/cliRelease";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { FORK_RELEASES_PAGE, type ForkRelease } from "./api.ts";

const RELEASES_API = "https://api.github.com/repos/Yarden-zamir/t3code/releases?per_page=10";
const CACHE_SECONDS = 600;

const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  html_url: Schema.String,
  draft: Schema.Boolean,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
});
const decodeReleases = Schema.decodeUnknownOption(Schema.Array(GitHubRelease));

const FALLBACK: ForkRelease = {
  tag: null,
  version: null,
  pageUrl: FORK_RELEASES_PAGE,
  macUrl: null,
  windowsUrl: null,
};

/** Picks the newest complete published release from a GitHub releases list, newest first. */
export function newestRelease(body: unknown): ForkRelease {
  const release = Option.getOrUndefined(decodeReleases(body))?.find(
    (r) => !r.draft && r.assets.some((asset) => asset.name === CLI_RELEASE_CHECKSUMS_FILE),
  );
  if (!release) return FALLBACK;
  const assetUrl = (suffix: string) =>
    release.assets.find((asset) => asset.name.endsWith(suffix))?.browser_download_url ?? null;
  return {
    tag: release.tag_name,
    version: release.tag_name.startsWith("v") ? release.tag_name.slice(1) : release.tag_name,
    pageUrl: release.html_url,
    macUrl: assetUrl("-arm64.dmg"),
    windowsUrl: assetUrl("-x64.exe"),
  };
}

/** Fails softly: an error or a rate limit of the public API gives the releases page only. */
export async function fetchNewestRelease(): Promise<ForkRelease> {
  try {
    const response = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "t3-machine-map" },
      // Unauthenticated GitHub API calls are limited per IP. The edge cache keeps answers 10 minutes.
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": CACHE_SECONDS, "300-599": -1 } },
    });
    return response.ok ? newestRelease(await response.json()) : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

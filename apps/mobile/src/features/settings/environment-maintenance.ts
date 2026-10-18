import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  CLI_RELEASES_PAGE_URL,
  type CliReleaseChannel,
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

export function canMaintainEnvironment(session: AuthSessionState | null, connected: boolean) {
  return (
    connected &&
    session?.authenticated === true &&
    sessionGrantsScope(session, AuthEnvironmentMaintainScope)
  );
}

export function supportsEnvironmentUpdate(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "serverSelfUpdate" | "desktopAppUpdate">,
) {
  return (
    capabilities.serverSelfUpdate !== undefined &&
    (capabilities.serverSelfUpdate !== "desktop-managed" || capabilities.desktopAppUpdate === true)
  );
}

export function canUpdateEnvironmentProvider(provider: ServerProvider) {
  const compatibility = provider.compatibilityAdvisory?.latestVersionStatus;
  return (
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate &&
    provider.versionAdvisory.latestVersion !== null &&
    compatibility !== "broken" &&
    compatibility !== "unsupported" &&
    provider.updateState?.status !== "running" &&
    provider.updateState?.status !== "queued"
  );
}

const decodeLatestRelease = Schema.decodeUnknownSync(Schema.Struct({ tag_name: Schema.String }));
const decodeReleaseIndex = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ tag_name: Schema.String, draft: Schema.optionalKey(Schema.Boolean) }),
  ),
);
const FEED_TAG = /<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g;

async function fetchReleases(url: string, accept: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, headers: { Accept: accept } });
  if (!response.ok) throw new Error(`Could not check releases (${response.status}). Try again.`);
  return response;
}

/**
 * Reads github.com release pages, which unlike api.github.com do not share 60 anonymous
 * requests an hour with every other device on the phone's network. Stable hosts read the
 * latest release. Nightly and preview are never marked latest, so they read the feed of
 * the ten newest releases.
 */
async function channelReleases(channel: CliReleaseChannel, signal: AbortSignal) {
  if (channel === "stable") {
    const response = await fetchReleases(
      `${CLI_RELEASES_PAGE_URL}/latest`,
      "application/json",
      signal,
    );
    return [decodeLatestRelease(await response.json())];
  }
  const response = await fetchReleases(
    `${CLI_RELEASES_PAGE_URL}.atom`,
    "application/atom+xml",
    signal,
  );
  return Array.from((await response.text()).matchAll(FEED_TAG), ([, tag_name = ""]) => ({
    tag_name,
  }));
}

/** Pages the API release index, for a preview that later nightlies pushed out of the feed. */
async function newestInReleaseIndex(channel: CliReleaseChannel, signal: AbortSignal) {
  for (let page = 1; ; page++) {
    const response = await fetchReleases(
      cliReleaseIndexPageUrl(page),
      "application/vnd.github+json",
      signal,
    );
    const releases = decodeReleaseIndex(await response.json());
    const version = newestCliReleaseVersion(releases, channel);
    if (version !== undefined || releases.length < 100) return version;
  }
}

export async function findEnvironmentUpdate(currentVersion: string, signal: AbortSignal) {
  const channel = cliReleaseChannelOf(currentVersion);
  const version =
    newestCliReleaseVersion(await channelReleases(channel, signal), channel) ??
    (await newestInReleaseIndex(channel, signal));
  if (version === undefined) throw new Error(`No ${channel} release was found.`);
  return compareSemverVersions(version, currentVersion) > 0 ? version : null;
}

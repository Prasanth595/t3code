import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Platform } from "react-native";

import { compareSemverVersions } from "@t3tools/shared/semver";

/**
 * The fork APK takes no OTA updates (scripts/fork-android-apk.sh), so it updates itself from the
 * GitHub releases of the fork instead. Fork Android adds an APK only to releases where the app
 * changed, so the newest APK can sit on an older release.
 */
interface ForkUpdaterModule {
  install(fileUri: string): Promise<void>;
}

export interface ForkApk {
  readonly version: string;
  readonly url: string;
}

const APK_SUFFIX = "-android.apk";

const GitHubReleases = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    assets: Schema.Array(
      Schema.Struct({ name: Schema.String, browser_download_url: Schema.String }),
    ),
  }),
);
const decodeReleases = Schema.decodeUnknownOption(GitHubReleases);

function versionFromTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * The newest published release with an APK. GitHub's list order is not reliable for nightly tags
 * whose run numbers cross a digit boundary (`.90000` sorts above `.110000`), so pick by semver.
 */
export function newestForkApk(body: unknown): ForkApk | null {
  let newest: ForkApk | null = null;
  for (const release of Option.getOrElse(decodeReleases(body), () => [])) {
    if (release.draft) continue;
    const asset = release.assets.find((candidate) => candidate.name.endsWith(APK_SUFFIX));
    if (!asset) continue;
    const candidate = {
      version: versionFromTag(release.tag_name),
      url: asset.browser_download_url,
    };
    if (newest === null || compareSemverVersions(candidate.version, newest.version) > 0) {
      newest = candidate;
    }
  }
  return newest;
}

export function createForkApkUpdateClient(input: {
  readonly repo: string | null;
  readonly installedVersion: string | undefined;
  readonly native: ForkUpdaterModule | null;
}) {
  let available: ForkApk | null = null;
  let downloadedUri: string | null = null;

  return {
    isEnabled: input.repo !== null && input.native !== null,
    checkForUpdateAsync: async () => {
      const response = await fetch(
        `https://api.github.com/repos/${input.repo}/releases?per_page=30`,
        { headers: { Accept: "application/vnd.github+json" } },
      );
      if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
      available = newestForkApk(await response.json());
      // Offer only a newer version. A stale list order must not try to install an older APK.
      return {
        isAvailable:
          available !== null &&
          (input.installedVersion === undefined ||
            compareSemverVersions(available.version, input.installedVersion) > 0),
        isRollBackToEmbedded: false,
      };
    },
    fetchUpdateAsync: async () => {
      if (!available) return { isNew: false, isRollBackToEmbedded: false };
      const { File, Paths } = await import("expo-file-system");
      const file = new File(Paths.cache, `t3code-${available.version}${APK_SUFFIX}`);
      if (file.exists) file.delete();
      await File.downloadFileAsync(available.url, file);
      downloadedUri = file.uri;
      return { isNew: true, isRollBackToEmbedded: false };
    },
    reloadAsync: async () => {
      if (!downloadedUri || !input.native) throw new Error("No update has been downloaded.");
      await input.native.install(downloadedUri);
    },
  };
}

export const forkApkUpdateClient = createForkApkUpdateClient({
  repo:
    Platform.OS === "android"
      ? ((Constants.expoConfig?.extra?.forkApkUpdatesRepo as string | null | undefined) ?? null)
      : null,
  installedVersion: Constants.expoConfig?.version,
  native:
    Platform.OS === "android"
      ? requireOptionalNativeModule<ForkUpdaterModule>("T3ForkUpdater")
      : null,
});

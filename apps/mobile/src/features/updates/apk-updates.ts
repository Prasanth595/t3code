import Constants from "expo-constants";
import { Directory, File, Paths } from "expo-file-system";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface MiraApkInstaller {
  canInstall(): boolean;
  openInstallPermissionSettings(): void;
  install(fileUri: string): void;
}

export interface MiraBuildInfo {
  readonly releaseTag: string;
  readonly builtAt: string;
  readonly repository: string;
}

export interface ApkRelease {
  readonly tag: string;
  readonly name: string;
  readonly createdAt: string;
  readonly downloadUrl: string;
}

interface GithubRelease {
  readonly tag_name: string;
  readonly name: string | null;
  readonly created_at: string;
  readonly draft: boolean;
  readonly assets: ReadonlyArray<{ readonly name: string; readonly browser_download_url: string }>;
}

const RELEASE_TAG_PREFIX = "mira-preview-";

export function readMiraBuildInfo(): MiraBuildInfo | null {
  const build = Constants.expoConfig?.extra?.miraBuild as Partial<MiraBuildInfo> | undefined;
  if (!build?.releaseTag || !build.builtAt || !build.repository) return null;
  return { releaseTag: build.releaseTag, builtAt: build.builtAt, repository: build.repository };
}

function installer(): MiraApkInstaller | null {
  return Platform.OS === "android"
    ? requireOptionalNativeModule<MiraApkInstaller>("MiraApkInstaller")
    : null;
}

/** Only APKs built by the release script know their own tag, so only they can update themselves. */
export function isApkUpdateSupported(): boolean {
  return readMiraBuildInfo() !== null && installer() !== null;
}

/** The newest release is newer than this build when it is another tag published after the build. */
export function newestApkRelease(
  releases: ReadonlyArray<GithubRelease>,
  build: MiraBuildInfo,
): ApkRelease | null {
  const candidates = releases
    .filter((release) => !release.draft && release.tag_name.startsWith(RELEASE_TAG_PREFIX))
    .map((release) => ({
      release,
      apk: release.assets.find((asset) => asset.name.toLowerCase().endsWith(".apk")),
    }))
    .filter((entry) => entry.apk !== undefined);
  const latest = [...candidates].sort(
    (a, b) => Date.parse(b.release.created_at) - Date.parse(a.release.created_at),
  )[0];
  if (!latest?.apk) return null;
  if (latest.release.tag_name === build.releaseTag) return null;
  if (Date.parse(latest.release.created_at) <= Date.parse(build.builtAt)) return null;
  return {
    tag: latest.release.tag_name,
    name: latest.release.name || latest.release.tag_name,
    createdAt: latest.release.created_at,
    downloadUrl: latest.apk.browser_download_url,
  };
}

export async function checkForApkUpdate(): Promise<ApkRelease | null> {
  const build = readMiraBuildInfo();
  if (!build) return null;
  const response = await fetch(
    `https://api.github.com/repos/${build.repository}/releases?per_page=20`,
    { headers: { accept: "application/vnd.github+json" } },
  );
  if (!response.ok) throw new Error(`GitHub a răspuns cu ${response.status}.`);
  return newestApkRelease((await response.json()) as ReadonlyArray<GithubRelease>, build);
}

export type ApkInstallOutcome = "installing" | "needs-permission";

/** Downloads the APK and hands it to Android's installer, which asks the user to confirm. */
export async function downloadAndInstallApk(release: ApkRelease): Promise<ApkInstallOutcome> {
  const native = installer();
  if (!native) throw new Error("Actualizarea din aplicație nu e disponibilă pe acest dispozitiv.");
  if (!native.canInstall()) {
    native.openInstallPermissionSettings();
    return "needs-permission";
  }
  const directory = new Directory(Paths.cache, "mira-updates");
  if (!directory.exists) directory.create({ intermediates: true });
  const target = new File(directory, "mira-update.apk");
  if (target.exists) target.delete();
  const file = await File.downloadFileAsync(release.downloadUrl, target);
  native.install(file.uri);
  return "installing";
}

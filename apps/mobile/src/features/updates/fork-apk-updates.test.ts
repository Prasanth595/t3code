import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-constants", () => ({ default: { expoConfig: {} } }));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

import { createForkApkUpdateClient, newestForkApk } from "./fork-apk-updates";

const release = (tag: string, apk: boolean, draft = false) => ({
  tag_name: tag,
  draft,
  assets: [
    { name: "SHA256SUMS", browser_download_url: "https://x/SHA256SUMS" },
    ...(apk
      ? [
          {
            name: `t3code-${tag.slice(1)}-android.apk`,
            browser_download_url: `https://x/${tag}.apk`,
          },
        ]
      : []),
  ],
});

describe("newestForkApk", () => {
  it("takes the newest published release that has an APK", () => {
    expect(
      newestForkApk([release("v3", false), release("v2", true, true), release("v1", true)]),
    ).toEqual({ version: "1", url: "https://x/v1.apk" });
  });

  it("picks by semver when GitHub lists a higher run number after a shorter one", () => {
    expect(
      newestForkApk([
        release("v0.1.1-nightly.20261018.90000", false),
        release("v0.1.1-nightly.20261018.70000", true),
        release("v0.1.1-nightly.20261018.110000", true),
      ]),
    ).toEqual({
      version: "0.1.1-nightly.20261018.110000",
      url: "https://x/v0.1.1-nightly.20261018.110000.apk",
    });
  });

  it("gives null without an APK or for an unexpected answer", () => {
    expect(newestForkApk([release("v1", false)])).toBeNull();
    expect(newestForkApk({ message: "API rate limit exceeded" })).toBeNull();
  });
});

describe("createForkApkUpdateClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const check = async (installedVersion: string) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([release("v3", false), release("v2", true)]))),
    );
    const client = createForkApkUpdateClient({
      repo: "owner/repo",
      installedVersion,
      native: { install: vi.fn() },
    });
    return client.checkForUpdateAsync();
  };

  it("offers the APK only when the release is newer than the installed version", async () => {
    expect((await check("1")).isAvailable).toBe(true);
    expect((await check("2")).isAvailable).toBe(false);
    expect((await check("3")).isAvailable).toBe(false);
  });

  it("is off without a repository or the native installer", () => {
    expect(
      createForkApkUpdateClient({ repo: null, installedVersion: "1", native: { install: vi.fn() } })
        .isEnabled,
    ).toBe(false);
    expect(
      createForkApkUpdateClient({ repo: "owner/repo", installedVersion: "1", native: null })
        .isEnabled,
    ).toBe(false);
  });
});

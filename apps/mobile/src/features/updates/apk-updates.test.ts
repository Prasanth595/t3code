import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("expo-file-system", () => ({ Directory: vi.fn(), File: vi.fn(), Paths: {} }));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

const { newestApkRelease } = await import("./apk-updates");

const build = {
  releaseTag: "mira-preview-2026-10-28-2",
  builtAt: "2026-10-28T12:00:00.000Z",
  repository: "andreimironstv/mira-ai",
};

function release(tag: string, createdAt: string, apk = true) {
  return {
    tag_name: tag,
    name: tag,
    created_at: createdAt,
    draft: false,
    assets: apk
      ? [{ name: "Mira.apk", browser_download_url: `https://example.test/${tag}.apk` }]
      : [],
  };
}

describe("newestApkRelease", () => {
  it("offers a later release built after this one", () => {
    expect(
      newestApkRelease(
        [
          release("mira-preview-2026-10-28-2", "2026-10-28T12:05:00.000Z"),
          release("mira-preview-2026-10-29-1", "2026-10-29T09:00:00.000Z"),
        ],
        build,
      ),
    ).toMatchObject({ tag: "mira-preview-2026-10-29-1" });
  });

  it("does not offer this build's own release, which is published after the build", () => {
    expect(
      newestApkRelease([release("mira-preview-2026-10-28-2", "2026-10-28T12:05:00.000Z")], build),
    ).toBeNull();
  });

  it("ignores releases without an APK and older releases", () => {
    expect(
      newestApkRelease(
        [
          release("mira-preview-2026-10-29-1", "2026-10-29T09:00:00.000Z", false),
          release("mira-preview-2026-10-27-1", "2026-10-27T09:00:00.000Z"),
        ],
        build,
      ),
    ).toBeNull();
  });
});

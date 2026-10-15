import { describe, expect, it } from "vite-plus/test";

import { FORK_RELEASES_PAGE } from "./api.ts";
import { newestRelease } from "./releases.ts";

const release = (tag: string, draft = false) => ({
  tag_name: tag,
  html_url: `https://github.com/Yarden-zamir/t3code/releases/tag/${tag}`,
  draft,
  prerelease: true,
  assets: [
    {
      name: `T3-Code-${tag.slice(1)}-arm64.dmg.blockmap`,
      browser_download_url: "https://x/dmg.blockmap",
    },
    { name: `T3-Code-${tag.slice(1)}-arm64.dmg`, browser_download_url: `https://x/${tag}.dmg` },
    { name: `T3-Code-${tag.slice(1)}-x64.exe`, browser_download_url: `https://x/${tag}.exe` },
    { name: "SHA256SUMS", browser_download_url: "https://x/SHA256SUMS" },
  ],
});

describe("newestRelease", () => {
  it("takes the first complete published release and its Mac and Windows installers", () => {
    const uploading = release("v0.0.48-nightly.3");
    const result = newestRelease([
      { ...uploading, assets: uploading.assets.filter((asset) => asset.name !== "SHA256SUMS") },
      release("v0.0.47-nightly.2", true),
      release("v0.0.46-nightly.1"),
      release("v0.0.45-nightly.0"),
    ]);
    expect(result).toEqual({
      tag: "v0.0.46-nightly.1",
      version: "0.0.46-nightly.1",
      pageUrl: "https://github.com/Yarden-zamir/t3code/releases/tag/v0.0.46-nightly.1",
      macUrl: "https://x/v0.0.46-nightly.1.dmg",
      windowsUrl: "https://x/v0.0.46-nightly.1.exe",
    });
  });

  it("gives null for a missing installer", () => {
    const result = newestRelease([
      { ...release("v1"), assets: release("v1").assets.filter((a) => a.name === "SHA256SUMS") },
    ]);
    expect(result.macUrl).toBeNull();
    expect(result.windowsUrl).toBeNull();
  });

  it("falls back to the releases page for an unexpected answer", () => {
    for (const body of [[], { message: "API rate limit exceeded" }, null, [{ tag_name: 1 }]]) {
      expect(newestRelease(body)).toEqual({
        tag: null,
        version: null,
        pageUrl: FORK_RELEASES_PAGE,
        macUrl: null,
        windowsUrl: null,
      });
    }
  });
});

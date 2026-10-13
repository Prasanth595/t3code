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
  ],
});

describe("newestRelease", () => {
  it("takes the first published release and its Mac and Windows installers", () => {
    const result = newestRelease([
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
    const result = newestRelease([{ ...release("v1"), assets: [] }]);
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

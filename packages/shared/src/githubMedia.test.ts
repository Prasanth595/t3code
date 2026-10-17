import { describe, expect, it } from "vite-plus/test";
import { githubMediaFetchUrl, githubMediaFileName, githubReleaseAsset } from "./githubMedia.ts";

describe("GitHub release media URLs", () => {
  it.each([
    ["https://github.com/owner/repo/releases/download/v1%2Btest/shot%20%231%25.png", true],
    ["http://github.com/o/r/releases/download/v1/a.png", false],
    ["https://example.com/o/r/releases/download/v1/a.png", false],
    ["https://www.github.com/o/r/releases/download/v1/a.png", false],
    ["https://github.com:443/o/r/releases/download/v1/a.png", false],
    ["https://github.com/o/r/releases/download/v1/..", false],
    ["https://github.com:444/o/r/releases/download/v1/a.png", false],
    ["https://user:password@github.com/o/r/releases/download/v1/a.png", false],
    ["https://github.com/o/r/releases/download/v1/", false],
    ["https://github.com/o/r/releases/download/v1/a.png/extra", false],
    ["https://github.com/o%2Fr/r/releases/download/v1/a.png", false],
    ["https://github.com/o/r/releases/download/%ZZ/a.png", false],
    ["https://github.com/o/r/releases/download/v%2F1/a.png", false],
    ["https://github.com/o/r/releases/download/v1/a%2Fb.png", false],
    ["https://github.com/o/r/releases/download/v1/a%00.png", false],
    ["https://github.com/o/r/releases/download/%E2%80%AEv1/a.png", false],
  ])("classifies and parses %s", (url, valid) => {
    expect(githubMediaFetchUrl(url)).toBe(valid ? url : null);
    expect(githubReleaseAsset(url)).toEqual(
      valid
        ? {
            owner: "owner",
            repo: "repo",
            tag: "v1+test",
            name: "shot #1%.png",
          }
        : null,
    );
    if (valid) expect(githubMediaFileName(url)).toBe("shot #1%.png");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { resolveUnstagedFiles } from "./gitActions.ts";

describe("resolveUnstagedFiles", () => {
  const file = (path: string, staged?: "none" | "partial" | "all") => ({
    path,
    insertions: 1,
    deletions: 0,
    ...(staged ? { staged } : {}),
  });

  it("includes every file when nothing is staged", () => {
    expect(resolveUnstagedFiles([file("a.ts", "none"), file("b.ts", "none")])).toEqual(new Set());
  });

  it("excludes files with nothing staged once something is staged", () => {
    expect(
      resolveUnstagedFiles([
        file("staged.ts", "all"),
        file("partial.ts", "partial"),
        file("unstaged.ts", "none"),
      ]),
    ).toEqual(new Set(["unstaged.ts"]));
  });

  it("includes every file when the server does not report staged state", () => {
    expect(resolveUnstagedFiles([file("a.ts"), file("b.ts")])).toEqual(new Set());
  });
});

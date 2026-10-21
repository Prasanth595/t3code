import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  isFileDiffCollapsed,
  isLineInFileDiff,
  reconcileDiffSlices,
  type DiffSlice,
  toggleFileDiffFoldForViewed,
} from "./pullRequestDiff.logic";

function fileWithHunks(
  hunks: ReadonlyArray<{
    deletionStart: number;
    deletionCount: number;
    additionStart: number;
    additionCount: number;
  }>,
): FileDiffMetadata {
  return { name: "src/app.ts", hunks } as unknown as FileDiffMetadata;
}

describe("isLineInFileDiff", () => {
  const file = fileWithHunks([
    { deletionStart: 10, deletionCount: 3, additionStart: 10, additionCount: 5 },
    { deletionStart: 40, deletionCount: 0, additionStart: 42, additionCount: 2 },
  ]);

  it("includes the first line of a hunk and excludes the one past its last", () => {
    expect(isLineInFileDiff(file, "right", 10)).toBe(true);
    expect(isLineInFileDiff(file, "right", 14)).toBe(true);
    expect(isLineInFileDiff(file, "right", 15)).toBe(false);
    expect(isLineInFileDiff(file, "left", 9)).toBe(false);
    expect(isLineInFileDiff(file, "left", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 13)).toBe(false);
  });

  it("keeps the two sides apart, since one line number means two lines", () => {
    expect(isLineInFileDiff(file, "right", 43)).toBe(true);
    expect(isLineInFileDiff(file, "left", 40)).toBe(false);
  });
});

describe("isFileDiffCollapsed", () => {
  // regression: #9174 diffs now expand by default; a reader's fold must survive new slices
  it("keeps a file the reader folded closed as the next slice arrives", () => {
    const toggled = new Set(["b.ts"]);
    expect(isFileDiffCollapsed("b.ts", null, toggled)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", null, toggled)).toBe(false);
  });
});

describe("toggleFileDiffFoldForViewed", () => {
  it("moves against whatever the toolbar last asked for", () => {
    expect([...toggleFileDiffFoldForViewed("a.ts", true, "expanded", new Set())]).toEqual(["a.ts"]);
    expect(toggleFileDiffFoldForViewed("a.ts", false, "expanded", new Set()).size).toBe(0);
  });
});

describe("reconcileDiffSlices", () => {
  const slice = (cursor: string | null, patch: string, nextCursor: string | null): DiffSlice => ({
    cursor,
    patch,
    truncated: false,
    nextCursor,
    omittedFileStats: [{ path: "large.bin", additions: 1, deletions: 0 }],
  });
  const loaded = [slice(null, "a", "2"), slice("2", "b", "3"), slice("3", "c", "4")];

  it("revalidates unchanged loaded pages in order without replacing them or loading more", () => {
    let state = { cursor: null as string | null, slices: loaded as ReadonlyArray<DiffSlice> };
    for (const [cursor, patch, nextCursor, expectedCursor] of [
      [null, "a", "2", "2"],
      ["2", "b", "3", "3"],
      ["3", "c", "4", "3"],
    ] as const) {
      expect(state.cursor).toBe(cursor);
      state = reconcileDiffSlices(state.slices, slice(cursor, patch, nextCursor));
      expect(state.cursor).toBe(expectedCursor);
      expect(state.slices).toBe(loaded);
    }
  });

  it("keeps earlier pages but replaces a changed page and discards its descendants", () => {
    const replacement = slice("2", "updated b", "new-3");
    const refreshed = reconcileDiffSlices(loaded, replacement);

    expect(refreshed.cursor).toBe("2");
    expect(refreshed.slices).toEqual([loaded[0], replacement]);
    expect(refreshed.slices[0]).toBe(loaded[0]);
    expect(loaded).toHaveLength(3);

    const nextPage = slice("new-3", "updated c", null);
    expect(reconcileDiffSlices(refreshed.slices, nextPage)).toEqual({
      cursor: "new-3",
      slices: [loaded[0], replacement, nextPage],
    });
  });
});

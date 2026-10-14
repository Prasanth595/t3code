import { describe, expect, it } from "vite-plus/test";

import {
  areAllDiffFilesCollapsed,
  isFileDiffCollapsed,
  setDiffFileCollapsed,
  toggleAllDiffFiles,
  type DiffFilesCollapseState,
} from "./diffCollapse";

const FILE_KEYS = ["src/app.ts", "src/index.ts"];
const FIRST_FILE_KEY = FILE_KEYS[0]!;
const EXPANDED: DiffFilesCollapseState = { foldOverride: "expanded", toggledFileKeys: new Set() };
const FOLDED: DiffFilesCollapseState = { foldOverride: "folded", toggledFileKeys: new Set() };

function collapsedKeys(fileKeys: ReadonlyArray<string>, state: DiffFilesCollapseState) {
  return new Set(
    fileKeys.filter((key) => isFileDiffCollapsed(key, state.foldOverride, state.toggledFileKeys)),
  );
}

describe("diff collapse controls", () => {
  it("reports whether every rendered file is collapsed", () => {
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set(FILE_KEYS))).toBe(true);
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toBe(false);
    expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
  });

  it("collapses all files when any rendered file is expanded", () => {
    const partial = setDiffFileCollapsed(FIRST_FILE_KEY, EXPANDED, true);
    const collapsed = toggleAllDiffFiles(FILE_KEYS, partial);
    expect(areAllDiffFilesCollapsed(FILE_KEYS, collapsedKeys(FILE_KEYS, collapsed))).toBe(true);
  });

  it("expands all files when every rendered file is collapsed", () => {
    const expanded = toggleAllDiffFiles(FILE_KEYS, FOLDED);
    expect(collapsedKeys(FILE_KEYS, expanded)).toEqual(new Set());
  });

  it("keeps a newly added file collapsed when its pending patch finishes loading", () => {
    const pendingFileKey = "new.ts\u0000new.ts\u0000change";
    const loadedFileKey = "new.ts\u0000new.ts\u0000new";
    const collapsed = toggleAllDiffFiles([FIRST_FILE_KEY, pendingFileKey], EXPANDED);

    const loadedKeys = [FIRST_FILE_KEY, loadedFileKey];
    expect(areAllDiffFilesCollapsed(loadedKeys, collapsedKeys(loadedKeys, collapsed))).toBe(true);
  });

  it("applies collapse and expand all to files arriving on later pages", () => {
    const collapsed = toggleAllDiffFiles([FIRST_FILE_KEY], EXPANDED);
    const nextPage = [...FILE_KEYS, "src/next-page.ts"];
    expect(areAllDiffFilesCollapsed(nextPage, collapsedKeys(nextPage, collapsed))).toBe(true);

    const expanded = toggleAllDiffFiles(FILE_KEYS, collapsed);
    expect(collapsedKeys(nextPage, expanded)).toEqual(new Set());
  });

  it("keeps individual file choices when later pages arrive", () => {
    const collapsed = toggleAllDiffFiles(FILE_KEYS, EXPANDED);
    const revealed = setDiffFileCollapsed(FIRST_FILE_KEY, collapsed, false);
    const nextPage = [...FILE_KEYS, "src/next-page.ts"];
    expect(collapsedKeys(nextPage, revealed)).toEqual(new Set(nextPage.slice(1)));

    const foldedAgain = setDiffFileCollapsed(FIRST_FILE_KEY, revealed, true);
    expect(areAllDiffFilesCollapsed(nextPage, collapsedKeys(nextPage, foldedAgain))).toBe(true);
  });

  it("keeps repeated file reveals expanded and clears exceptions on the next bulk collapse", () => {
    const revealed = setDiffFileCollapsed(FIRST_FILE_KEY, FOLDED, false);
    const revealedAgain = setDiffFileCollapsed(FIRST_FILE_KEY, revealed, false);
    expect(collapsedKeys(FILE_KEYS, revealedAgain)).toEqual(new Set([FILE_KEYS[1]]));

    const collapsed = toggleAllDiffFiles(FILE_KEYS, revealedAgain);
    expect(areAllDiffFilesCollapsed(FILE_KEYS, collapsedKeys(FILE_KEYS, collapsed))).toBe(true);
  });
});

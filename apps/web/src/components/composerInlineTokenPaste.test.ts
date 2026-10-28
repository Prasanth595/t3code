import { describe, expect, it } from "vite-plus/test";

import { rewriteImportedContextReferences } from "./composerInlineTokenPaste";

describe("rewriteImportedContextReferences", () => {
  const pasted =
    "See ![shot.png](t3-context://v1/image/img_a) and [notes.md](t3-context://v1/file/file_b) in [build](t3-context://v1/terminal/term_c)";

  it.each([
    [
      "points an imported record at its new id",
      new Map([["img_a", "img_z"]]),
      "See ![shot.png](t3-context://v1/image/img_z) and [notes.md](t3-context://v1/file/file_b) in [build](t3-context://v1/terminal/term_c)",
    ],
    [
      "pastes a declined record as its label",
      new Map([
        ["img_a", null],
        ["file_b", null],
      ]),
      "See shot.png and notes.md in [build](t3-context://v1/terminal/term_c)",
    ],
  ])("%s", (_, importedIds, expected) => {
    expect(rewriteImportedContextReferences(pasted, importedIds)).toBe(expected);
  });
});

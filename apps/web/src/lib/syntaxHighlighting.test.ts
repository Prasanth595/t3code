import { getFiletypeFromFileName } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import "./syntaxHighlighting";

describe("dialect file types", () => {
  it.each([
    ["src/init.luau", "lua"],
    ["styles/page.xsl", "xml"],
    ["styles/page.xslt", "xml"],
  ])("%s highlights as %s", (path, language) => {
    expect(getFiletypeFromFileName(path)).toBe(language);
  });
});

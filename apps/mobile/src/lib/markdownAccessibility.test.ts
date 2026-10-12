import { describe, expect, it } from "vite-plus/test";
import { markdownAccessibilityLabel } from "./markdownAccessibility";

describe("Markdown accessibility labels", () => {
  it.each([
    [
      "**Node.js** · [option link](https://example.com)\n\nUse `TypeScript`.",
      "Node.js · option link Use TypeScript.",
    ],
    [
      "[**Docs**][guide] and <https://example.com>\n\n[guide]: ./README.md",
      "Docs and https://example.com",
    ],
    ["`[not a link](no)` [![preview](image.png)](file.pdf)", "[not a link](no) preview"],
    ["[Docs][guide]\n\n> [guide]: ./README.md", "Docs"],
    ["![Preview][image]\n\n- [image]: ./preview.png", "Preview"],
    ['<img src="./preview.png" alt="Preview">', "Preview"],
    ["![](choice.png)", "![](choice.png)"],
    ["![][choice]\n\n[choice]: choice.png", "![][choice]\n\n[choice]: choice.png"],
  ])("reads %s as %s", (markdown, expected) => {
    expect(markdownAccessibilityLabel(markdown)).toBe(expected);
  });
});

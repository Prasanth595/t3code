import { describe, expect, it } from "vite-plus/test";
import { markdownWithBlockImages } from "./markdownDocument";

describe("images inside running text", () => {
  it("moves each image into its own paragraph", () => {
    expect(markdownWithBlockImages("Imports. ![a](a.png)\n\nPreview ![b](b.png) and more.")).toBe(
      "Imports. \n\n![a](a.png)\n\nPreview \n\n![b](b.png)\n\n and more.",
    );
  });

  it("keeps the new paragraphs inside lists and blockquotes", () => {
    expect(markdownWithBlockImages("1. **Imports.** Done. ![a](a.png)")).toBe(
      "1. **Imports.** Done. \n\n   ![a](a.png)",
    );
    expect(markdownWithBlockImages("> Quoted ![a](a.png)")).toBe("> Quoted \n>\n> ![a](a.png)");
  });

  it("leaves images that already start their own line", () => {
    for (const markdown of [
      "Text\n\n![a](a.png)",
      "- ![a](a.png)",
      "See [![badge](b.svg)](https://example.com) here",
      "`![a](a.png)` in code",
    ]) {
      expect(markdownWithBlockImages(markdown)).toBe(markdown);
    }
  });
});

import { describe, expect, it } from "vite-plus/test";
import { markdownAccessibility } from "./markdownAccessibility";

describe("markdownAccessibility", () => {
  it("reads formatted option text and exposes each link separately", () => {
    expect(
      markdownAccessibility(
        "**Node.js** · [option link](https://example.com)\n\nUse `TypeScript`.",
      ),
    ).toEqual({
      label: "Node.js · option link Use TypeScript.",
      links: [{ label: "option link", href: "https://example.com" }],
    });
  });

  it("resolves reference links and autolinks without reading definitions aloud", () => {
    expect(
      markdownAccessibility("[**Docs**][guide] and <https://example.com>\n\n[guide]: ./README.md"),
    ).toEqual({
      label: "Docs and https://example.com",
      links: [
        { label: "Docs", href: "./README.md" },
        { label: "https://example.com", href: "https://example.com" },
      ],
    });
  });

  it("keeps code literal and uses image alternative text for linked images", () => {
    expect(markdownAccessibility("`[not a link](no)` [![preview](image.png)](file.pdf)")).toEqual({
      label: "[not a link](no) preview",
      links: [{ label: "preview", href: "file.pdf" }],
    });
  });
});

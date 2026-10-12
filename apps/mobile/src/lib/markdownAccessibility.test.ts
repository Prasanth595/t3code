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
      targets: [{ kind: "link", label: "option link", href: "https://example.com" }],
    });
  });

  it("resolves reference links and autolinks without reading definitions aloud", () => {
    expect(
      markdownAccessibility("[**Docs**][guide] and <https://example.com>\n\n[guide]: ./README.md"),
    ).toEqual({
      label: "Docs and https://example.com",
      targets: [
        { kind: "link", label: "Docs", href: "./README.md" },
        { kind: "link", label: "https://example.com", href: "https://example.com" },
      ],
    });
  });

  it("keeps code literal and uses image alternative text for linked images", () => {
    expect(markdownAccessibility("`[not a link](no)` [![preview](image.png)](file.pdf)")).toEqual({
      label: "[not a link](no) preview",
      targets: [
        { kind: "link", label: "preview", href: "file.pdf" },
        { kind: "image", label: "preview", href: "image.png" },
      ],
    });
  });

  it.each(["> [guide]: ./README.md", "- [guide]: ./README.md"])(
    "resolves a definition nested in a container: %s",
    (definition) => {
      expect(markdownAccessibility(`[Docs][guide]\n\n${definition}`).targets).toEqual([
        { kind: "link", label: "Docs", href: "./README.md" },
      ]);
    },
  );

  it("keeps the first reference definition, as Markdown does", () => {
    expect(
      markdownAccessibility("[Docs][guide]\n\n> [guide]: ./first.md\n\n[guide]: ./second.md")
        .targets,
    ).toEqual([{ kind: "link", label: "Docs", href: "./first.md" }]);
  });

  it("exposes recognized inline-code files without treating prose or fenced code as links", () => {
    expect(
      markdownAccessibility("`src/auth.ts:12` and `Node.js`\n\n```ts\nsrc/hidden.ts\n```").targets,
    ).toEqual([{ kind: "link", label: "src/auth.ts:12", href: "src/auth.ts:12" }]);
  });

  it("exposes a standalone image as an image preview, including extensionless URLs", () => {
    expect(markdownAccessibility("![Preview](https://example.com/api/image?id=1)").targets).toEqual(
      [{ kind: "image", label: "Preview", href: "https://example.com/api/image?id=1" }],
    );
  });

  it("resolves image references using nested definitions", () => {
    expect(markdownAccessibility("![Preview][image]\n\n> [image]: ./preview.png").targets).toEqual([
      { kind: "image", label: "Preview", href: "./preview.png" },
    ]);
  });

  it("uses the existing HTML conversion for image targets", () => {
    expect(markdownAccessibility('<img src="./preview.png" alt="Preview">').targets).toEqual([
      { kind: "image", label: "Preview", href: "./preview.png" },
    ]);
  });
});

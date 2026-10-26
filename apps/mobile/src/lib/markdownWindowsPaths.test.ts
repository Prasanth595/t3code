import { describe, expect, it } from "vite-plus/test";
// This bundled WASM build exercises the same C++ parser used by the native renderer.
import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import type { ASTNode } from "react-native-enriched-markdown/src/web/types";
import {
  markdownForNativeRendering,
  markdownWithFileEmbeds,
  markdownWithHtml,
  markdownWithInlineFileLinks,
  markdownWithTableBreaks,
  markdownWithWindowsPathDestinations,
  parseMarkdownDocument,
  type MarkdownNode,
} from "./markdownDocument";
import { markdownImageSources } from "./markdownImageSources";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";

function nativeDocument(markdown: string) {
  return parseMarkdown(markdownForNativeRendering(markdown, ENRICHED_INLINE_FILE_LINK_REGEX));
}

function destinations(node: MarkdownNode | ASTNode): string[] {
  const url = "url" in node ? node.url : "attributes" in node ? node.attributes?.url : undefined;
  const children = "children" in node ? (node.children ?? []) : [];
  return [...(url ? [url] : []), ...children.flatMap(destinations)];
}

describe("markdownWithWindowsPathDestinations", () => {
  it.each([
    { name: "JavaScript", parse: parseMarkdownDocument },
    { name: "native", parse: nativeDocument },
  ])("preserves the original #12615 destinations through the $name parser", async ({ parse }) => {
    const document = await parse(
      [
        String.raw`![shot](C:\Users\me\.t3\_build\shot.png "Shot")`,
        String.raw`[settings](C:\Users\me\.claude\settings.json) and [site](https://example.com/a\.b)`,
        "![ref][ref]",
        String.raw`[ref]: \\wsl.localhost\Ubuntu\.t3\ref.png`,
      ].join("\n\n"),
    );

    expect(destinations(document)).toEqual([
      String.raw`C:\Users\me\.t3\_build\shot.png`,
      String.raw`C:\Users\me\.claude\settings.json`,
      "https://example.com/a.b",
      String.raw`\\wsl.localhost\Ubuntu\.t3\ref.png`,
    ]);
  });

  it("keeps an escaped closing delimiter inside one native image without trailing text", async () => {
    const document = await nativeDocument(String.raw`![shot](C:\a\)shot.png "Shot")`);

    expect(destinations(document)).toEqual([String.raw`C:\a\)shot.png`]);
    expect(document.children?.[0]?.children?.map((node) => node.type)).toEqual(["Image"]);
    expect(document.children?.[0]?.children?.[0]?.attributes?.title).toBe("Shot");
  });

  it.each([
    { name: "JavaScript", parse: parseMarkdownDocument },
    { name: "native", parse: nativeDocument },
  ])(
    "preserves linked HTML Windows images in tables through the $name parser",
    async ({ parse }) => {
      const document = await parse(
        [
          "| Preview | Status |",
          "| - | - |",
          String.raw`| <a href="https://example.com/?a=1&#124;2"><img src="C:\me\.t3\&amp;copy;.png"></a><br><img src="\\server\share\_shot.png"> | done |`,
        ].join("\n"),
      );

      expect(destinations(document)).toEqual([
        "https://example.com/?a=1%7C2",
        String.raw`C:\me\.t3\&copy;.png`,
        String.raw`\\server\share\_shot.png`,
      ]);
      const table = document.children?.[0];
      expect(document.children).toHaveLength(1);
      expect(table?.type.toLowerCase()).toBe("table");
      expect(table).toMatchObject({ children: [{}, {}] });
    },
  );

  it("preserves HTML and inline-file destinations through native parsing", async () => {
    const document = await nativeDocument(
      [
        String.raw`![shot](<\\\\server\\share\\_shot.png>)`,
        String.raw`<img src="C:\me\.t3\&amp;copy;.png">`,
        "`" + String.raw`C:\repo\_private\a&copy;.ts` + "`",
      ].join("\n\n"),
    );

    expect(destinations(document)).toEqual([
      String.raw`\\server\share\_shot.png`,
      String.raw`C:\me\.t3\&copy;.png`,
      String.raw`C:\repo\_private\a&copy;.ts`,
    ]);
  });

  it("preserves Windows destinations when turning file embeds into native links", async () => {
    const paths = [String.raw`C:\repo\.t3\report.csv`, String.raw`\\server\share\_report.pdf`];
    const source = `![report](<${paths[0]}>)\n\n![ref][file]\n\n[file]: <${paths[1]}>`;
    const content = markdownWithInlineFileLinks(
      markdownWithWindowsPathDestinations(markdownWithHtml(source)),
      ENRICHED_INLINE_FILE_LINK_REGEX,
    );
    const files = markdownWithFileEmbeds(content, () => "Report");
    const document = await parseMarkdown(markdownWithTableBreaks(files.markdown));

    expect(files.fileHrefs).toEqual(new Set(paths));
    expect(destinations(document)).toEqual(paths);
    expect(document.children?.flatMap((node) => node.children?.map((child) => child.type))).toEqual(
      ["Link", "Link"],
    );
  });

  it("does not let a code example redirect a real image with a lookalike decoded path", () => {
    const path = String.raw`C:\Users\me.t3\shot.png`;
    const markdown = [
      "`" + String.raw`![example](C:\Users\me\.t3\shot.png)` + "`",
      `![real](${path})`,
    ].join("\n\n");

    expect(markdownWithWindowsPathDestinations(markdown)).toBe(markdown);
    expect(markdownImageSources(markdown)).toEqual([path]);
  });

  it("repairs mixed paths independently of unrelated Windows prose", () => {
    const path = String.raw`C:/Users/me\.t3/shot.png`;
    const markdown = `![shot](${path})`;

    expect(markdownImageSources(markdown)).toEqual([path]);
    expect(markdownImageSources(String.raw`Working in C:\repo` + "\n\n" + markdown)).toEqual([
      path,
    ]);
  });

  it("retains encoded separators and intentional ampersand escapes", () => {
    for (const [destination, path] of [
      [String.raw`C:\\me\\.t3\\shot.png`, String.raw`C:\me\.t3\shot.png`],
      [String.raw`\\\\server\\share\\_shot.png`, String.raw`\\server\share\_shot.png`],
      [String.raw`C:\me\a\&copy;.png`, String.raw`C:\me\a&copy;.png`],
      [String.raw`C:\me\\\&copy;.png`, String.raw`C:\me\&copy;.png`],
    ]) {
      expect(markdownImageSources(`![shot](<${destination}>)`)).toEqual([path]);
    }
  });

  it("leaves URLs, relative destinations, and literal Markdown examples alone", () => {
    const markdown = [
      String.raw`![remote](https://example.com/a\_b.png?path=C:\repo\&copy;&encoded=%5C#part)`,
      String.raw`![file](file:///C:/me/a\_b.png) ![relative](.\a\_b.png) \*not\*`,
      "`" + String.raw`![example](C:\me\.t3\shot.png)` + "`",
      "```md\n" + String.raw`![example](\\server\share\_shot.png)` + "\n```",
    ].join("\n\n");
    expect(markdownWithWindowsPathDestinations(markdown)).toBe(markdown);
  });
});

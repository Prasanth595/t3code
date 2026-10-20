import { describe, expect, it } from "vite-plus/test";
import { markdownHtmlContent, markdownWithHtml, parseMarkdownDocument } from "./markdownDocument";
import { markdownImageSources } from "./markdownImageSources";

describe("HTML in native Markdown", () => {
  it("preserves screenshot URLs and captions from GitHub HTML image embeds", () => {
    expect(
      markdownHtmlContent(
        '<img width="900" alt="Before > after [settings]" src="https://example.com/before.png?a=1&amp;b=2" />',
      ),
    ).toBe("![Before > after \\[settings\\]](<https://example.com/before.png?a=1\\&b=2>)");
    expect(
      markdownHtmlContent(
        "<a href='https://example.com'><img src='https://example.com/banner.svg' alt='Review' /></a>",
      ),
    ).toBe("[![Review](<https://example.com/banner.svg>)](<https://example.com>)");
  });

  it("decodes HTML attributes once and preserves entity-shaped query values through Markdown", () => {
    const markdown =
      '<img alt="&amp;lt;" src="https://example.com/shot.png?label=&amp;lt;&amp;sig=a%26b">';
    expect(markdownWithHtml(markdown)).toBe(
      "![\\&lt;](<https://example.com/shot.png?label=\\&lt;\\&sig=a%26b>)",
    );
    expect(markdownImageSources(markdown)).toEqual([
      "https://example.com/shot.png?label=&lt;&sig=a%26b",
    ]);
    const paragraph = parseMarkdownDocument(markdown).children[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type === "paragraph")
      expect(paragraph.children[0]).toMatchObject({ type: "image", alt: "&lt;" });
  });

  it("ignores code delimiters in HTML attributes and comments when collecting screenshots", () => {
    const markdown =
      '<details data-example="`">\n<summary>Proof</summary>\n<img src="https://example.com/shot.png" alt="Screenshot">\n<!-- ` -->\n</details>';
    expect(markdownHtmlContent(markdown)).toContain(
      "![Screenshot](<https://example.com/shot.png>)",
    );
    expect(markdownImageSources(markdown)).toEqual(["https://example.com/shot.png"]);
    expect(markdownWithHtml(markdown)).not.toContain("<img");
  });

  it("removes bot metadata and details wrappers while keeping the content", () => {
    const markdown =
      "<!-- generated bot metadata -->\n<details>\n<summary>Walkthrough</summary>\n\n## Changes\n\nText\n\n</details>";
    const result = markdownWithHtml(markdown);
    expect(result).not.toContain("<!--");
    expect(result).not.toContain("<details>");
    expect(result).toContain("**Walkthrough**");
    expect(result).toContain("## Changes");
    expect(parseMarkdownDocument(markdown).children.some((node) => node.type === "html")).toBe(
      false,
    );
  });

  it("collects HTML and Markdown screenshots while leaving inline and fenced code literal", () => {
    const markdown =
      '```html\n<img src="literal.png">\n```\n\nUse `<img src="inline.png">` here.\n\n<img src="one.png">\n\n![Two](two.png)\n\n<img src="one.png">';
    expect(markdownImageSources(markdown)).toEqual(["one.png", "two.png"]);
    const result = markdownWithHtml(markdown);
    expect(result).toContain('```html\n<img src="literal.png">\n```');
    expect(result).toContain('`<img src="inline.png">`');
  });

  it("turns HTML anchors into Markdown links, including inline tags in headings and table cells", () => {
    const markdown = [
      '## Deploying with &nbsp;<a href="https://workers.dev"><img alt="Workers" src="https://example.com/logo.svg" width="16"></a> &nbsp;Workers',
      "",
      "| Status | Preview URL |",
      "| -|-|",
      "| Done <br>[View logs](https://example.com/logs) | <a href='https://commit.example.com'>Commit Preview URL</a><br><br><a href='https://branch.example.com'>Branch Preview URL</a> |",
    ].join("\n");
    const document = parseMarkdownDocument(markdown);
    const links: Array<{ url: string; text: string }> = [];
    const visit = (node: (typeof document.children)[number] | typeof document) => {
      if (node.type === "link")
        links.push({
          url: node.url,
          text: node.children
            .map((child) => ("value" in child ? child.value : child.type))
            .join(""),
        });
      if ("children" in node) node.children.forEach(visit);
    };
    visit(document);
    expect(links).toEqual([
      { url: "https://workers.dev", text: "image" },
      { url: "https://example.com/logs", text: "View logs" },
      { url: "https://commit.example.com", text: "Commit Preview URL" },
      { url: "https://branch.example.com", text: "Branch Preview URL" },
    ]);
    expect(document.children[1]).toMatchObject({ type: "table" });
    if (document.children[1]?.type === "table")
      expect(document.children[1].children).toHaveLength(2);
  });

  it("keeps anchor text unlinked for unsafe or unclosed hrefs", () => {
    expect(markdownWithHtml('Run <a href="javascript:alert(1)">this</a> now')).toBe("Run this now");
    expect(markdownWithHtml("<p><a href='https://example.com'>open</p>")).toBe("\n\nopen\n\n");
    expect(markdownWithHtml("Mail <a href='mailto:a@example.com'>us</a>")).toBe(
      "Mail [us](<mailto:a@example.com>)",
    );
  });
});

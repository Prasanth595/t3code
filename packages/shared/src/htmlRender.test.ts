import { describe, expect, it } from "vite-plus/test";

import {
  htmlRenderTheme,
  injectHtmlRenderBootstrap,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
  chatVisualsAsText,
  splitChatVisuals,
  withoutOpenVisual,
} from "./htmlRender.ts";
import { T3_CODE_LIGHT_THEME_COLORS } from "./themePalettes.ts";
import { htmlRenderFromToolItem } from "./toolOutput.ts";

const reference = { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 };

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="t3-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "iframe", "plaintext"])("keeps the bootstrap outside %s content", (tag) => {
    const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf(`<${tag}>`));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf("<template>"));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="t3-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });
});

describe("injectHtmlRenderBootstrap with a host theme", () => {
  it("uses only the given theme instead of following the system scheme", () => {
    const theme = htmlRenderTheme(T3_CODE_LIGHT_THEME_COLORS, "light");
    const injected = injectHtmlRenderBootstrap("<p>x</p>", theme);
    expect(injected).toContain(":root{color-scheme:light;");
    expect(injected).not.toContain("prefers-color-scheme");
  });
});

describe("splitChatVisuals", () => {
  it("separates visual blocks from the markdown around them", () => {
    const text = ["Intro", "", "```visual", "<div>chart</div>", "```", "", "Outro"].join("\n");
    expect(splitChatVisuals(text)).toEqual([
      { kind: "markdown", text: "Intro\n" },
      { kind: "visual", html: "<div>chart</div>", complete: true },
      { kind: "markdown", text: "\nOutro" },
    ]);
  });

  it("marks a visual still streaming as incomplete", () => {
    expect(splitChatVisuals(["Hi", "```visual", "<div>"].join("\n"))).toEqual([
      { kind: "markdown", text: "Hi" },
      { kind: "visual", html: "<div>", complete: false },
    ]);
  });

  it("leaves out an empty visual, as the relay sends for a cut-off page", () => {
    expect(splitChatVisuals(["Hi", "````visual", "", "````", "Bye"].join("\n"))).toEqual([
      { kind: "markdown", text: "Hi" },
      { kind: "markdown", text: "Bye" },
    ]);
  });

  it("keeps visual fences quoted inside another code block as markdown", () => {
    const text = ["````md", "```visual", "<div/>", "```", "````"].join("\n");
    expect(splitChatVisuals(text)).toEqual([{ kind: "markdown", text }]);
  });
});

describe("chatVisualsAsText", () => {
  it("keeps a visual's words and drops its markup, styles and scripts", () => {
    const text = [
      "Intro",
      "````visual",
      "<style>p{color:red}</style><h2>Sales</h2><p>Oct &amp; Nov</p><script>draw()</script>",
      "````",
      "Outro",
    ].join("\n");
    expect(chatVisualsAsText(text)).toBe("Intro\n\n[Visual: Sales Oct & Nov]\n\nOutro");
  });

  it("leaves replies without visuals untouched", () => {
    expect(chatVisualsAsText("Plain ```ts\ncode\n```")).toBe("Plain ```ts\ncode\n```");
  });
});

describe("withoutOpenVisual", () => {
  it("drops a visual cut off at the end and keeps finished ones", () => {
    const done = ["Intro", "````visual", "<p>A</p>", "````"].join("\n");
    const cut = [done, "", "More", "", "````visual", "<div><p>Ha"].join("\n");
    expect(withoutOpenVisual(cut)).toBe(`${done}\n\nMore`);
    expect(withoutOpenVisual(done)).toBe(done);
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    const link = (url: unknown, modifiers = {}) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url, ...modifiers },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
      metaKey: false,
      ctrlKey: false,
    });
    expect(
      readHtmlRenderLinkRequest(link("https://example.com/a", { metaKey: true, ctrlKey: "yes" })),
    ).toEqual({ id: 1, url: "https://example.com/a", metaKey: true, ctrlKey: false });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ type: "t3-html-render-link", url: "https://example.com" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderImageRequest", () => {
  it("accepts http(s) and inline image URLs in an open-image notification", () => {
    const image = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "t3/notifications/open-image",
      params,
    });
    expect(
      readHtmlRenderImageRequest(image({ src: "data:image/png;base64,AA", name: " Chart " })),
    ).toEqual({
      src: "data:image/png;base64,AA",
      name: "Chart",
    });
    expect(readHtmlRenderImageRequest(image({ src: "https://example.com/a.png" }))).toEqual({
      src: "https://example.com/a.png",
      name: "Image",
    });
    expect(readHtmlRenderImageRequest(image({ src: "javascript:alert(1)" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "data:text/html,<p>" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "blob:null/1" }))).toBeUndefined();
  });
});

describe("htmlRenderFromToolItem", () => {
  const result = { htmlRender: reference, message: "Rendered above your reply." };

  it("reads the reference from each provider's result envelope", () => {
    for (const [toolName, output] of [
      ["mcp__t3-code__html_render", [{ type: "text", text: JSON.stringify(result) }]],
      ["t3-code.html_render", { structuredContent: result, content: [] }],
      ["t3-code-thread_1_html_render", JSON.stringify(result)],
      ["html_render", result],
    ] as const) {
      expect(htmlRenderFromToolItem({ toolName, output })).toEqual(reference);
    }
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  injectHtmlRenderBootstrap,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
} from "./htmlRender.ts";
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
  const image = (params: unknown) => ({
    jsonrpc: "2.0",
    method: "t3/notifications/open-image",
    params,
  });

  it("accepts http(s) and inline image URLs in a single-image notification", () => {
    expect(
      readHtmlRenderImageRequest(image({ src: "data:image/png;base64,AA", name: " Chart " })),
    ).toEqual({
      images: [{ src: "data:image/png;base64,AA", name: "Chart" }],
      index: 0,
    });
    expect(readHtmlRenderImageRequest(image({ src: "https://example.com/a.png" }))).toEqual({
      images: [{ src: "https://example.com/a.png", name: "Image" }],
      index: 0,
    });
    expect(readHtmlRenderImageRequest(image({ src: "javascript:alert(1)" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "data:text/html,<p>" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "blob:null/1" }))).toBeUndefined();
  });

  it("keeps the clicked position in a block of images", () => {
    const params = {
      index: 2,
      images: [
        { src: "https://example.com/1.png", name: "First" },
        { src: "https://example.com/2.png", name: "Second" },
        { src: "https://example.com/3.png", name: "Third" },
      ],
    };
    expect(readHtmlRenderImageRequest(image(params))).toEqual(params);
  });

  it("opens the first image when the position is missing or out of range", () => {
    const images = [{ src: "https://example.com/1.png", name: "First" }];
    expect(readHtmlRenderImageRequest(image({ images }))).toEqual({ images, index: 0 });
    expect(readHtmlRenderImageRequest(image({ images, index: 4 }))).toEqual({ images, index: 0 });
    expect(readHtmlRenderImageRequest(image({ images, index: -1 }))).toEqual({ images, index: 0 });
    expect(readHtmlRenderImageRequest(image({ images, index: 0.5 }))).toEqual({
      images,
      index: 0,
    });
  });

  it("rejects a block with an empty, oversized, or unsafe entry", () => {
    expect(readHtmlRenderImageRequest(image({ index: 0, images: [] }))).toBeUndefined();
    expect(
      readHtmlRenderImageRequest(image({ index: 0, images: "https://example.com/1.png" })),
    ).toBeUndefined();
    expect(
      readHtmlRenderImageRequest(
        image({
          index: 1,
          images: [
            { src: "https://example.com/1.png", name: "First" },
            { src: "javascript:alert(1)", name: "Second" },
          ],
        }),
      ),
    ).toBeUndefined();
    const tooMany = Array.from({ length: 25 }, (_, index) => ({
      src: `https://example.com/${index}.png`,
      name: `Image ${index}`,
    }));
    expect(readHtmlRenderImageRequest(image({ index: 0, images: tooMany }))).toBeUndefined();
    expect(
      readHtmlRenderImageRequest(image({ index: 0, images: tooMany.slice(0, 24) }))?.images,
    ).toHaveLength(24);
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

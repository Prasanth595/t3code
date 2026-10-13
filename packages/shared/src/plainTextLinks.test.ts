import { describe, expect, it } from "vite-plus/test";

import { splitPlainTextLinks } from "./plainTextLinks.ts";

const urls = (text: string) =>
  splitPlainTextLinks(text).flatMap((segment) => (segment.kind === "url" ? [segment.url] : []));

describe("splitPlainTextLinks", () => {
  it("keeps the surrounding prose around a link", () => {
    expect(
      splitPlainTextLinks("Mocks: https://example.com/a.html (press 1-5). Which one?"),
    ).toEqual([
      { kind: "text", text: "Mocks: " },
      { kind: "url", url: "https://example.com/a.html" },
      { kind: "text", text: " (press 1-5). Which one?" },
    ]);
  });

  it("drops punctuation and brackets that close the sentence, not the URL", () => {
    expect(urls("See https://example.com/a.")).toEqual(["https://example.com/a"]);
    expect(urls("(see https://example.com/a)")).toEqual(["https://example.com/a"]);
    expect(urls("[mock](https://example.com/a)")).toEqual(["https://example.com/a"]);
    expect(urls("**https://example.com/a**")).toEqual(["https://example.com/a"]);
  });

  it("keeps brackets the URL opened itself", () => {
    expect(urls("https://en.wikipedia.org/wiki/Fence_(disambiguation).")).toEqual([
      "https://en.wikipedia.org/wiki/Fence_(disambiguation)",
    ]);
  });

  it("leaves text without links as one segment", () => {
    expect(splitPlainTextLinks("No links, just http:// here")).toEqual([
      { kind: "text", text: "No links, just http:// here" },
    ]);
  });
});

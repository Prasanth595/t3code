import { describe, expect, it } from "vite-plus/test";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";
import { markdownWithInlineFileLinks } from "./markdownDocument";

const rewrite = (markdown: string) =>
  markdownWithInlineFileLinks(markdown, ENRICHED_INLINE_FILE_LINK_REGEX);

describe("inline code that names a file", () => {
  it("becomes a link to the same path", () => {
    expect(rewrite("See `src/math.ts:2` and `./README.md`.")).toBe(
      "See [src/math.ts:2](<src/math.ts:2>) and [./README.md](<./README.md>).",
    );
  });

  it("keeps commands, identifiers and URLs as code", () => {
    const markdown = "Run `vp test run`, call `useMemo`, open `https://example.com/a.ts`.";
    expect(rewrite(markdown)).toBe(markdown);
  });

  it("leaves fenced code blocks and code already inside a link alone", () => {
    const markdown = "```\nsrc/math.ts:2\n```\n\n[`src/math.ts`](src/math.ts)";
    expect(rewrite(markdown)).toBe(markdown);
  });

  it("handles double-backtick spans", () => {
    expect(rewrite("Open ``src/math.ts`` now.")).toBe("Open [src/math.ts](<src/math.ts>) now.");
  });
});

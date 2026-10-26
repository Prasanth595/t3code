import { describe, expect, it } from "vite-plus/test";

import { sanitizeCommitSubject, sanitizeNextPrompt } from "./textGenerationUtils.ts";

describe("sanitizeCommitSubject", () => {
  // regression: #19181 truncation split grapheme clusters at the subject limit
  it.each([
    { name: "an emoji", prefixLength: 71, character: "🚀" },
    { name: "an accented character", prefixLength: 71, character: "e\u0301" },
    { name: "a joined emoji", prefixLength: 65, character: "👨‍👩‍👧‍👦" },
  ])("keeps $name intact at the subject limit", ({ prefixLength, character }) => {
    const prefix = "a".repeat(prefixLength);

    expect(sanitizeCommitSubject(`${prefix}${character} more`)).toBe(prefix);
  });
});

describe("sanitizeNextPrompt", () => {
  it.each(["", "   ", '""', "\n"])("returns null for an empty reply (%j)", (raw) => {
    expect(sanitizeNextPrompt(raw)).toBeNull();
  });

  it("strips wrapping quotes and surrounding whitespace", () => {
    expect(sanitizeNextPrompt('  "Run the tests again"  ')).toBe("Run the tests again");
  });

  it("truncates a runaway reply to the composer-sized limit", () => {
    const result = sanitizeNextPrompt("a".repeat(400));
    expect(result).toHaveLength(280);
    expect(result?.endsWith("...")).toBe(true);
  });
});

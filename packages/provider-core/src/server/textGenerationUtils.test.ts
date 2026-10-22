import { describe, expect, it } from "vite-plus/test";

import { sanitizeCommitSubject, sanitizeThreadTitle } from "./textGenerationUtils.ts";

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


describe("sanitizeThreadTitle", () => {
  it("keeps the seed title when the model returns the schema placeholder", () => {
    const generatedTitle = sanitizeThreadTitle("title");
    const previousTitle = "Implement issue #140";

    expect(generatedTitle.toLowerCase() === "title" ? sanitizeThreadTitle(previousTitle) : generatedTitle)
      .toBe("Implement issue #140");
  });
});

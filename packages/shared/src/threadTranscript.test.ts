import { describe, expect, it } from "vite-plus/test";

import { newestTranscriptItems } from "./threadTranscript.ts";

describe("newestTranscriptItems", () => {
  it("keeps every item that fits", () => {
    expect(newestTranscriptItems(["a", "b"], 10_000)).toEqual({
      items: ["a", "b"],
      omittedItems: 0,
    });
  });

  it("drops the oldest items first and counts them", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ index, text: "x".repeat(1_000) }));
    const fitted = newestTranscriptItems(items, 4_096 + 3_100);
    expect(fitted.items.map((item) => item.index)).toEqual([7, 8, 9]);
    expect(fitted.omittedItems).toBe(7);
  });
});

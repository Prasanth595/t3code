import { describe, expect, it } from "vite-plus/test";

import { wideOrderedListMarkerDigits } from "./orderedListMarkers";

const numberedList = (count: number, marker = "1.") =>
  Array.from({ length: count }, () => `${marker} item`).join("\n");

describe("wideOrderedListMarkerDigits", () => {
  it("ignores text and lists that fit the normal gutter", () => {
    expect(wideOrderedListMarkerDigits("just a message")).toBe(0);
    expect(wideOrderedListMarkerDigits("We shipped it in 2026. More later.")).toBe(0);
    expect(wideOrderedListMarkerDigits(numberedList(99))).toBe(0);
  });

  it("covers written and renderer-generated three-digit markers", () => {
    expect(wideOrderedListMarkerDigits("100. item")).toBe(3);
    expect(wideOrderedListMarkerDigits(numberedList(100))).toBe(3);
    expect(wideOrderedListMarkerDigits(numberedList(100, "> 1."))).toBe(3);
  });

  it("measures ordered markers nested in other list items", () => {
    expect(wideOrderedListMarkerDigits("100. 1. item")).toBe(3);
    expect(wideOrderedListMarkerDigits("- 1000. nested")).toBe(4);
  });
});

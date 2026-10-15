import { describe, expect, it } from "vite-plus/test";

import { widestOrderedListMarkerDigits } from "./orderedListMarkers";

describe("widestOrderedListMarkerDigits", () => {
  it("returns 0 without ordered lists", () => {
    expect(widestOrderedListMarkerDigits("just a message")).toBe(0);
    expect(widestOrderedListMarkerDigits("- one\n- two")).toBe(0);
    expect(widestOrderedListMarkerDigits("In 2026. we shipped it")).toBe(0);
    expect(widestOrderedListMarkerDigits("Version 1.2 is out")).toBe(0);
  });

  it("measures the largest number across the message", () => {
    const list = Array.from({ length: 130 }, (_, index) => `${index + 1}. item`).join("\n");
    expect(widestOrderedListMarkerDigits(list)).toBe(3);
    expect(widestOrderedListMarkerDigits("1. a\n2. b\n\ntext\n\n1. c")).toBe(1);
    expect(widestOrderedListMarkerDigits("98. a\n99. b")).toBe(2);
    expect(widestOrderedListMarkerDigits("1000) a")).toBe(4);
  });

  it("finds nested, quoted, and empty items", () => {
    expect(widestOrderedListMarkerDigits("1. a\n   100. nested")).toBe(3);
    expect(widestOrderedListMarkerDigits("> > 250. quoted")).toBe(3);
    expect(widestOrderedListMarkerDigits("text\n100.")).toBe(3);
  });

  it("ignores leading zeros the renderer drops", () => {
    expect(widestOrderedListMarkerDigits("007. agent")).toBe(1);
  });
});

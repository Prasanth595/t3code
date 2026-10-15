import { describe, expect, it } from "vite-plus/test";

import { wideOrderedListMarkerDigits } from "./orderedListMarkers";

const numberedList = (count: number, marker = (index: number) => `${index + 1}.`) =>
  Array.from({ length: count }, (_, index) => `${marker(index)} item`).join("\n");

describe("wideOrderedListMarkerDigits", () => {
  it("returns 0 while every number fits in two digits", () => {
    expect(wideOrderedListMarkerDigits("just a message")).toBe(0);
    expect(wideOrderedListMarkerDigits("- one\n- two")).toBe(0);
    expect(wideOrderedListMarkerDigits(numberedList(99))).toBe(0);
    expect(wideOrderedListMarkerDigits("We shipped it in 2026. More later.")).toBe(0);
  });

  it("measures the widest rendered number", () => {
    expect(wideOrderedListMarkerDigits(numberedList(130))).toBe(3);
    expect(wideOrderedListMarkerDigits("1000) a")).toBe(4);
  });

  it("counts from the first marker like the renderer", () => {
    expect(wideOrderedListMarkerDigits("99. first\n1. second")).toBe(3);
    expect(wideOrderedListMarkerDigits(numberedList(101, () => "1."))).toBe(3);
    expect(wideOrderedListMarkerDigits("007. agent")).toBe(0);
  });

  it("finds lists nested in other blocks", () => {
    expect(wideOrderedListMarkerDigits("- 100000. nested")).toBe(6);
    expect(wideOrderedListMarkerDigits("> > 250. quoted")).toBe(3);
    expect(wideOrderedListMarkerDigits("1. a\n\n   100. nested")).toBe(3);
  });

  it("ignores numbers in code blocks", () => {
    expect(wideOrderedListMarkerDigits("- a\n\n```\n123456789. example\n```")).toBe(0);
    expect(wideOrderedListMarkerDigits("text\n\n    250. indented code")).toBe(0);
  });
});

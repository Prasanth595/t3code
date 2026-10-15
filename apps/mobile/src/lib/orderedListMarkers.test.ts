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
    expect(wideOrderedListMarkerDigits("Version 1.2 is out")).toBe(0);
    expect(wideOrderedListMarkerDigits(`${numberedList(60)}\n\ntext\n\n${numberedList(50)}`)).toBe(
      0,
    );
    const withSubLists = Array.from(
      { length: 60 },
      (_, index) => `${index + 1}. item\n   1. sub\n   2. sub`,
    ).join("\n");
    expect(wideOrderedListMarkerDigits(withSubLists)).toBe(0);
  });

  it("measures the widest rendered number", () => {
    expect(wideOrderedListMarkerDigits(numberedList(130))).toBe(3);
    expect(wideOrderedListMarkerDigits("1000) a")).toBe(4);
    expect(wideOrderedListMarkerDigits("text\r\n\r\n100.\r\n")).toBe(3);
  });

  it("covers numbers the renderer counts up to", () => {
    expect(wideOrderedListMarkerDigits("99. first\n1. second")).toBe(3);
    expect(wideOrderedListMarkerDigits(numberedList(101, () => "1."))).toBe(3);
    expect(wideOrderedListMarkerDigits(`${numberedList(60)}\n\n${numberedList(50)}`)).toBe(3);
    expect(wideOrderedListMarkerDigits("99. first\n[^note]: text\n1. second")).toBe(3);
    expect(wideOrderedListMarkerDigits("007. agent")).toBe(0);
  });

  it("finds lists nested in other blocks", () => {
    expect(wideOrderedListMarkerDigits("- 100000. nested")).toBe(6);
    expect(wideOrderedListMarkerDigits("> > 250. quoted")).toBe(3);
    expect(wideOrderedListMarkerDigits("1. a\n\n   100. nested")).toBe(3);
    expect(wideOrderedListMarkerDigits("    code\n\n100. item")).toBe(3);
  });

  it("stays linear on long runs of bullets and spaces", () => {
    expect(wideOrderedListMarkerDigits(`${"-    ".repeat(40)}x`)).toBe(0);
  });

  it("ignores fenced code", () => {
    expect(wideOrderedListMarkerDigits("- a\n\n```\n123456789. example\n```")).toBe(0);
    expect(wideOrderedListMarkerDigits("~~~~\n250. a\n~~~\n300. b\n~~~~\n1. c")).toBe(0);
    expect(wideOrderedListMarkerDigits("```\n250. a\n```\n\n150. b")).toBe(3);
  });
});

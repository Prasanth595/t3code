import { describe, expect, it } from "vite-plus/test";

import { refillSpan, restoreText, usageReadout } from "./usageReadout";

describe("usageReadout", () => {
  it("shows what is left by default", () => {
    expect(usageReadout("remaining", 76, 7)).toEqual({
      percent: 76,
      label: "Left",
      word: "left",
      text: "76% left",
      evenPace: { percent: 7, windowText: "7% of the window left", byNowText: "7% left by now" },
    });
  });

  it("shows what is used as the complement, pace mark included", () => {
    expect(usageReadout("used", 76, 7)).toEqual({
      percent: 24,
      label: "Used",
      word: "used",
      text: "24% used",
      evenPace: {
        percent: 93,
        windowText: "93% of the window elapsed",
        byNowText: "93% used by now",
      },
    });
  });

  it("has no pace mark when the window has no clock", () => {
    expect(usageReadout("used", 100, null)).toEqual({
      percent: 0,
      label: "Used",
      word: "used",
      text: "0% used",
      evenPace: null,
    });
  });
});

describe("restoreText", () => {
  it("adds to what is left and takes from what is used", () => {
    expect(restoreText("remaining", 12)).toBe("+12%");
    expect(restoreText("used", 12)).toBe("−12%");
  });
});

describe("refillSpan", () => {
  it("fills the empty end when showing what is left", () => {
    expect(refillSpan("remaining", usageReadout("remaining", 16, null), 84)).toEqual({
      start: 16,
      width: 84,
      onFill: false,
    });
    expect(refillSpan("remaining", usageReadout("remaining", 76, null), 12)).toEqual({
      start: 88,
      width: 12,
      onFill: false,
    });
  });

  it("covers the tail of the used fill when showing what is used", () => {
    expect(refillSpan("used", usageReadout("used", 76, null), 12)).toEqual({
      start: 12,
      width: 12,
      onFill: true,
    });
    expect(refillSpan("used", usageReadout("used", 16, null), 100)).toEqual({
      start: 0,
      width: 84,
      onFill: true,
    });
  });

  it("draws nothing when nothing would come back", () => {
    expect(refillSpan("used", usageReadout("used", 100, null), 40)).toBeNull();
    expect(refillSpan("remaining", usageReadout("remaining", 40, null), 0)).toBeNull();
  });
});

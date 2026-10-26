import { describe, expect, it } from "vite-plus/test";

import { readableOnWhite } from "./readableSyntaxTheme";

function contrastOnWhite(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

describe("readableOnWhite", () => {
  it("darkens pierre-light's faint yellow and cyan to AA contrast on white", () => {
    for (const color of ["#d5a910", "#08c0ef", "#d5901c", "#1ca1c7"]) {
      expect(contrastOnWhite(readableOnWhite(color))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("leaves colors that already read on white unchanged", () => {
    expect(readableOnWhite("#d32a61")).toBe("#d32a61");
    expect(readableOnWhite("#0a0a0a")).toBe("#0a0a0a");
  });

  it("keeps an alpha suffix and ignores non-hex values", () => {
    expect(readableOnWhite("#d5a91080")).toMatch(/80$/);
    expect(readableOnWhite("var(--x)")).toBe("var(--x)");
  });
});

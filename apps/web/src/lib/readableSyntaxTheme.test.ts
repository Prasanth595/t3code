import { describe, expect, it } from "vite-plus/test";

import { readableOnLightCode, readableSyntaxColor } from "./readableSyntaxTheme";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  return (luminance(background) + 0.05) / (luminance(foreground) + 0.05);
}

// pierre-light's faintest syntax colors: yellow, cyan, orange, teal, green, pink.
const PIERRE_LIGHT_FAINT = ["#d5a910", "#08c0ef", "#d5901c", "#1ca1c7", "#199f43", "#d32a61"];
// Light code surfaces: the code background, added and deleted lines, and changed words on each.
const LIGHT_CODE_SURFACES = ["#fcfcfc", "#ecf9f4", "#fef0f0", "#ccecdf", "#f8d3d4"];

describe("readableOnLightCode", () => {
  it("brings pierre-light's faint colors to 4.5:1 on every light code surface", () => {
    for (const color of PIERRE_LIGHT_FAINT) {
      for (const surface of LIGHT_CODE_SURFACES) {
        expect(contrast(readableOnLightCode(color), surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps tokens that differed only in lightness apart, in pierre-light's order", () => {
    // Comments stay lighter than punctuation; operators stay darker than numbers.
    expect(luminance(readableSyntaxColor("#737373"))).toBeGreaterThan(
      luminance(readableSyntaxColor("#636363")) + 0.02,
    );
    expect(luminance(readableSyntaxColor("#1ca1c7"))).toBeGreaterThan(
      luminance(readableSyntaxColor("#08c0ef")) + 0.02,
    );
  });

  it("leaves colors that already read unchanged", () => {
    expect(readableOnLightCode("#693acf")).toBe("#693acf");
    expect(readableOnLightCode("#0a0a0a")).toBe("#0a0a0a");
  });

  it("keeps an alpha suffix and ignores non-hex values", () => {
    expect(readableOnLightCode("#d5a91080")).toMatch(/80$/);
    expect(readableOnLightCode("var(--x)")).toBe("var(--x)");
  });
});

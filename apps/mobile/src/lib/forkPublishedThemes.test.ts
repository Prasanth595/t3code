import type { EnvironmentTheme } from "@t3tools/contracts";
import { T3_CODE_DARK_THEME_COLORS } from "@t3tools/shared/themePalettes";
import { describe, expect, it, vi } from "vite-plus/test";

// The native color parser: anything but a hex or rgb() color is not drawable.
vi.mock("react-native", () => ({
  processColor: (value: string) => (/^(#|rgba?\()/.test(value) ? 1 : null),
}));

const { parseThemeShadow, publishedThemeColors } = await import("./forkPublishedThemes");

const theme = (fields: Partial<EnvironmentTheme>): EnvironmentTheme => ({
  id: "tick3d-light",
  name: "Tick3d Light",
  appearance: "light",
  ...fields,
});

describe("publishedThemeColors", () => {
  it("puts the listed colors and the seeds on top of the stock palette", () => {
    const colors = publishedThemeColors(
      theme({ canvas: "#E4E7FF", accent: "#6C5CE7", colors: { text: "#000000", border: "nope" } }),
      "light",
    );
    expect(colors?.canvas).toBe("#E4E7FF");
    expect(colors?.accent).toBe("#6C5CE7");
    expect(colors?.text).toBe("#000000");
    // A value that the app cannot draw keeps the stock role.
    expect(colors?.border).not.toBe("nope");
  });

  it("gives no palette for an appearance without a variant", () => {
    expect(publishedThemeColors(theme({ colors: { text: "#000000" } }), "dark")).toBeNull();
  });

  it("builds a variant on the stock palette of that appearance, without the seeds", () => {
    const colors = publishedThemeColors(
      theme({ canvas: "#E4E7FF", variants: { dark: { text: "#F3F0FF" } } }),
      "dark",
    );
    expect(colors?.text).toBe("#F3F0FF");
    expect(colors?.canvas).toBe(T3_CODE_DARK_THEME_COLORS.canvas);
  });
});

describe("parseThemeShadow", () => {
  it("reads a hard offset shadow", () => {
    expect(parseThemeShadow("4px 4px 0 0 #B9A8FF")).toEqual({
      offsetX: 4,
      offsetY: 4,
      radius: 0,
      spread: 0,
      color: "#B9A8FF",
    });
  });

  it("takes the first of several shadows and skips inset ones", () => {
    expect(parseThemeShadow("2px 3px rgba(0, 0, 0, 0.5), 9px 9px #000")?.color).toBe(
      "rgba(0, 0, 0, 0.5)",
    );
    expect(parseThemeShadow("inset 0 0 4px #000")).toBeNull();
  });
});

import { SYSTEM_COLORS_THEME_ID } from "@t3tools/shared/themePalettes";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getStandardPaintedThemeColors,
  getSystemColorsTheme,
  getThemeDefinition,
  setSystemAccentColor,
  subscribeToCustomThemes,
  themeColorToHex,
} from "./themePalette";

const hex = (value: string | undefined) => themeColorToHex(value ?? "")?.slice(0, 7);

describe("System colors theme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not exist outside a desktop that reports its accent", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => null } });

    expect(getSystemColorsTheme()).toBeNull();
    expect(getThemeDefinition(SYSTEM_COLORS_THEME_ID)).toBeNull();
  });

  it("recolors the standard palette with the desktop accent in both appearances", () => {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null },
      desktopBridge: { getSystemAccentColor: () => "#3584e4" },
    });

    const theme = getThemeDefinition(SYSTEM_COLORS_THEME_ID);
    expect(theme?.id).toBe(SYSTEM_COLORS_THEME_ID);
    expect(hex(theme?.colors.accent)).toBe("#3584e4");
    expect(hex(theme?.variants?.dark?.accent)).toBe("#3584e4");
    expect(theme?.colors.canvas).toBe(getStandardPaintedThemeColors("light").canvas);
    expect(theme?.variants?.dark?.canvas).toBe(getStandardPaintedThemeColors("dark").canvas);
  });

  it("follows accent changes and falls back to the standard palette without one", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToCustomThemes(listener);

    setSystemAccentColor("#e66100");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(hex(getSystemColorsTheme()?.colors.accent)).toBe("#e66100");

    setSystemAccentColor("#e66100");
    expect(listener).toHaveBeenCalledTimes(1);

    setSystemAccentColor(null);
    expect(getSystemColorsTheme()?.colors).toEqual(getStandardPaintedThemeColors("light"));
    expect(getSystemColorsTheme()?.variants?.dark).toEqual(getStandardPaintedThemeColors("dark"));
    unsubscribe();
  });
});

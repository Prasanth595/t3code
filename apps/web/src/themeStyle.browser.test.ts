import { afterEach, describe, expect, it } from "vite-plus/test";

import { environmentThemeDefinition } from "./hooks/useEnvironmentTheme";
import {
  applyThemePalette,
  getActiveThemeFonts,
  setEnvironmentThemes,
  THEME_USER_CSS_ELEMENT_ID,
} from "./themePalette";
import { fontSettingOrThemeFont } from "./appearanceFonts";

const PLAIN_THEME = {
  id: "plain",
  name: "Plain",
  appearance: "light",
  canvas: "#ffffff",
  accent: "#6c5ce7",
} as const;

const STYLED_THEME = {
  ...PLAIN_THEME,
  id: "styled",
  name: "Styled",
  radius: "0",
  borderWidth: "3px",
  shadow: "4px 4px 0 0 #000",
  fonts: { sans: "Bricolage Grotesque" },
  canvasPattern: "dots",
  css: "body { outline: 1px solid red; }",
} as const;

function userCss(): string | null {
  return document.getElementById(THEME_USER_CSS_ELEMENT_ID)?.textContent ?? null;
}

afterEach(() => {
  setEnvironmentThemes([]);
  applyThemePalette("system");
});

describe("theme style fields", () => {
  it("leaves the root untouched for a theme without style fields", () => {
    setEnvironmentThemes([environmentThemeDefinition(PLAIN_THEME)]);
    applyThemePalette("plain");

    const root = document.documentElement;
    expect(environmentThemeDefinition(PLAIN_THEME).style).toBeUndefined();
    expect(root.style.getPropertyValue("--radius")).toBe("");
    expect(root.style.getPropertyValue("--theme-border-width")).toBe("");
    expect(root.style.getPropertyValue("--theme-shadow")).toBe("");
    expect(root.dataset.themeRadius).toBeUndefined();
    expect(root.dataset.canvasPattern).toBeUndefined();
    expect(getActiveThemeFonts()).toEqual({});
    expect(userCss()).toBeNull();
  });

  it("applies the fields and user CSS of the active theme only", () => {
    setEnvironmentThemes([
      environmentThemeDefinition(PLAIN_THEME),
      environmentThemeDefinition(STYLED_THEME),
    ]);
    applyThemePalette("styled");

    const root = document.documentElement;
    expect(root.style.getPropertyValue("--radius")).toBe("0");
    expect(root.style.getPropertyValue("--theme-border-width")).toBe("3px");
    expect(root.dataset.themeShadow).toBe("");
    expect(root.dataset.canvasPattern).toBe("dots");
    expect(getActiveThemeFonts()).toEqual({ sans: "Bricolage Grotesque" });
    expect(userCss()).toBe(STYLED_THEME.css);

    applyThemePalette("plain");
    expect(root.style.getPropertyValue("--radius")).toBe("");
    expect(root.dataset.themeShadow).toBeUndefined();
    expect(root.dataset.canvasPattern).toBeUndefined();
    expect(getActiveThemeFonts()).toEqual({});
    expect(userCss()).toBeNull();
  });
});

describe("font precedence", () => {
  it("prefers an explicit setting and falls back to the theme font when empty", () => {
    expect(fontSettingOrThemeFont("Inter", "Bricolage Grotesque")).toBe("Inter");
    expect(fontSettingOrThemeFont("  ", "Bricolage Grotesque")).toBe("Bricolage Grotesque");
    expect(fontSettingOrThemeFont("", undefined)).toBe("");
  });
});

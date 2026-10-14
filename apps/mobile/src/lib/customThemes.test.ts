import { afterEach, describe, expect, it } from "vite-plus/test";
import { T3_CHAT_THEME } from "@t3tools/shared/themePalettes";

import {
  findMobileThemeDefinition,
  isSelectableThemeId,
  parseStoredCustomThemes,
  parseThemeFile,
  setCustomMobileThemes,
  themeDefinitionToFile,
  themeIdFromName,
  toCanonicalThemeColor,
} from "./customThemes";
import { normalizeMobileThemeId } from "./mobileTheme";

const themeFile = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  name: "Pink Love",
  appearance: "dark",
  colors: { canvas: "#1b0d1a", accent: "#ff69b4" },
  ...overrides,
});

afterEach(() => {
  setCustomMobileThemes([]);
});

describe("parseThemeFile", () => {
  it("derives an id from the name and keeps unspecified roles on the standard palette", () => {
    const theme = parseThemeFile(themeFile());

    expect(theme.id).toBe("pink-love");
    expect(theme.label).toBe("Pink Love");
    expect(theme.appearance).toBe("dark");
    expect(theme.colors.canvas).toBe(toCanonicalThemeColor("#1b0d1a"));
    expect(theme.colors.text).toBe(T3_CHAT_THEME.variants!.dark!.text);
  });

  it("accepts an explicit id and dark-only variants", () => {
    const theme = parseThemeFile(
      themeFile({
        id: "pink-love-custom",
        appearance: "light",
        variants: { dark: { canvas: "#000000" } },
      }),
    );

    expect(theme.id).toBe("pink-love-custom");
    expect(theme.appearance).toBe("light");
    expect(theme.variants?.dark?.canvas).toBe(toCanonicalThemeColor("#000000"));
  });

  it.each([
    ["an unsupported version", { version: 2 }, "unsupported version"],
    ["a missing name", { name: "" }, "need a name"],
    ["an unknown appearance", { appearance: "sepia" }, 'appearance of "light" or "dark"'],
    ["an unknown color role", { colors: { bogus: "#fff" } }, '"bogus" is not a supported'],
    ["a non-literal color", { colors: { canvas: "var(--x)" } }, "must be a literal CSS color"],
    ["a reserved id", { id: "t3-chat" }, 'The theme id "t3-chat" is reserved'],
    ["the mobile default id", { id: "t3-code" }, 'The theme id "t3-code" is reserved'],
    ["an invalid id", { id: "Not Valid" }, "may only contain lowercase"],
    [
      "a variant repeating the base appearance",
      { variants: { dark: { canvas: "#000" } } },
      "must not repeat the base appearance",
    ],
  ])("rejects %s", (_label, overrides, message) => {
    expect(() => parseThemeFile(themeFile(overrides))).toThrow(message);
  });

  it("rejects values that are not JSON objects", () => {
    expect(() => parseThemeFile("nope")).toThrow("must contain a JSON object");
  });
});

describe("toCanonicalThemeColor", () => {
  it("canonicalizes literal colors to the oklch form the palettes store", () => {
    expect(toCanonicalThemeColor("#ff0000")).toMatch(/^oklch\(/);
    expect(toCanonicalThemeColor("rgba(0, 0, 0, 0.5)")).toMatch(/\/ 0\.5\)$/);
  });

  it("returns null for values that are not literal colors", () => {
    expect(toCanonicalThemeColor("var(--x)")).toBeNull();
    expect(toCanonicalThemeColor(42)).toBeNull();
  });
});

describe("themeIdFromName", () => {
  it("slugs names and falls back when nothing usable remains", () => {
    expect(themeIdFromName("  Ocean Breeze! 2 ")).toBe("ocean-breeze-2");
    expect(themeIdFromName("!!!")).toBe("custom-theme");
  });
});

describe("theme files round-trip", () => {
  it("re-parses a serialized palette into the same id, label, and colors", () => {
    const theme = parseThemeFile(themeFile());
    const reparsed = parseThemeFile(JSON.parse(JSON.stringify(themeDefinitionToFile(theme))));

    expect(reparsed.id).toBe(theme.id);
    expect(reparsed.label).toBe(theme.label);
    expect(reparsed.colors).toEqual(theme.colors);
  });

  it("drops stored entries this build cannot read and repeated ids", () => {
    const valid = themeDefinitionToFile(parseThemeFile(themeFile()));
    const themes = parseStoredCustomThemes([valid, valid, { version: 9 }, "junk"]);

    expect(themes.map((theme) => theme.id)).toEqual(["pink-love"]);
  });
});

describe("custom theme registry", () => {
  it("resolves an installed custom id to its palette and keeps it selectable", () => {
    const theme = parseThemeFile(themeFile());
    setCustomMobileThemes([theme]);

    expect(findMobileThemeDefinition("pink-love")).toBe(theme);
    expect(normalizeMobileThemeId("pink-love")).toBe("pink-love");
  });

  it("falls back to the default when a custom id is no longer installed", () => {
    expect(findMobileThemeDefinition("pink-love")).toBeNull();
    expect(normalizeMobileThemeId("pink-love")).toBe("t3-code");
  });
});

describe("isSelectableThemeId", () => {
  const stored = [parseThemeFile(themeFile())];

  it("keeps built-in and mobile-only ids without any stored custom theme", () => {
    for (const id of ["t3-code", "material-you", "t3-chat", "grove"]) {
      expect(isSelectableThemeId(id, [])).toBe(true);
    }
  });

  it("keeps a custom id only while its theme is stored", () => {
    expect(isSelectableThemeId("pink-love", stored)).toBe(true);
    expect(isSelectableThemeId("pink-love", [])).toBe(false);
  });

  it("rejects values that are not strings", () => {
    expect(isSelectableThemeId(undefined, stored)).toBe(false);
    expect(isSelectableThemeId(7, stored)).toBe(false);
  });
});

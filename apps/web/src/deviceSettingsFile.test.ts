import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_DEVICE_APPEARANCE,
  parseDeviceSettingsFile,
  pickDeviceSettings,
  planCustomThemeImport,
  serializeDeviceSettingsFile,
} from "./deviceSettingsFile";
import { parseThemeFile, serializeThemeFile, THEME_FILE_VERSION } from "./themePalette";

function makeTheme(name: string, canvas: string) {
  return parseThemeFile({
    version: THEME_FILE_VERSION,
    name,
    appearance: "dark",
    colors: { canvas },
  });
}

const BUILT_IN_THEMES = new Set(["system", "light", "dark"]);
const isBuiltInTheme = (themeId: string) => BUILT_IN_THEMES.has(themeId);

describe("serializeDeviceSettingsFile", () => {
  it("writes only changed device settings and the custom themes the selection uses", () => {
    const nightfall = makeTheme("Nightfall", "#1a1b26");
    const unused = makeTheme("Unused", "#202020");

    const file: unknown = JSON.parse(
      serializeDeviceSettingsFile({
        settings: {
          ...DEFAULT_CLIENT_SETTINGS,
          chatWidth: "wide",
          legacySidebarEnabled: true,
          onboardingCompletedAt: "2026-10-01T00:00:00.000Z",
        },
        appearance: { ...DEFAULT_DEVICE_APPEARANCE, theme: nightfall.id },
        customThemes: [nightfall, unused],
      }),
    );

    expect(file).toEqual({
      chatWidth: "wide",
      legacySidebarEnabled: true,
      theme: nightfall.id,
      customThemes: [JSON.parse(serializeThemeFile(nightfall))],
    });
  });
});

describe("parseDeviceSettingsFile", () => {
  it("restores exported settings and resets every covered setting the file omits", () => {
    const nightfall = makeTheme("Nightfall", "#1a1b26");
    const exported = {
      settings: { ...DEFAULT_CLIENT_SETTINGS, chatWidth: "wide" as const, sendShortcut: "mod-enter" as const },
      appearance: {
        theme: nightfall.id,
        appearanceMode: "dark" as const,
        themeHalves: { light: "light", dark: nightfall.id },
        advancedTypography: true,
      },
    };
    const file: unknown = JSON.parse(
      serializeDeviceSettingsFile({ ...exported, customThemes: [nightfall] }),
    );

    const imported = parseDeviceSettingsFile(file, isBuiltInTheme);

    expect(imported.settings).toEqual(pickDeviceSettings(exported.settings));
    expect(imported.appearance).toEqual(exported.appearance);
    expect(imported.customThemes).toEqual([nightfall]);
    expect(imported.warnings).toEqual([]);

    const partial = parseDeviceSettingsFile({ wordWrap: false }, isBuiltInTheme);
    expect(partial.settings).toEqual({
      ...pickDeviceSettings(DEFAULT_CLIENT_SETTINGS),
      wordWrap: false,
    });
    expect(partial.appearance).toEqual(DEFAULT_DEVICE_APPEARANCE);
  });

  it("applies valid values and reports unknown keys and wrong types as warnings", () => {
    const imported = parseDeviceSettingsFile(
      {
        chatWidth: 42,
        wordWrap: false,
        onboardingCompletedAt: "2026-10-01T00:00:00.000Z",
        addedInALaterVersion: true,
        theme: "missing-theme",
        appearanceMode: "dark",
      },
      isBuiltInTheme,
    );

    expect(imported.settings.chatWidth).toBe(DEFAULT_CLIENT_SETTINGS.chatWidth);
    expect(imported.settings.wordWrap).toBe(false);
    expect(imported.settings).not.toHaveProperty("onboardingCompletedAt");
    expect(imported.appearance.theme).toBe(DEFAULT_DEVICE_APPEARANCE.theme);
    expect(imported.appearance.appearanceMode).toBe("dark");
    expect(imported.warnings).toEqual([
      "chatWidth: invalid value, reset to its default",
      "onboardingCompletedAt: not a device setting, ignored",
      "addedInALaterVersion: not a device setting, ignored",
      "theme: invalid value, reset to its default",
    ]);
  });
});

describe("planCustomThemeImport", () => {
  it("adds new themes and replaces local themes whose definition differs", () => {
    const local = [makeTheme("Nightfall", "#1a1b26"), makeTheme("Dusk", "#303030")];

    const plan = planCustomThemeImport(
      [makeTheme("Nightfall", "#1a1b26"), makeTheme("Dusk", "#404040"), makeTheme("Dawn", "#f0f0f0")],
      local,
    );

    expect(plan.added.map((theme) => theme.id)).toEqual(["dawn"]);
    expect(plan.replaced.map((theme) => theme.id)).toEqual(["dusk"]);
  });
});

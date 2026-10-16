import { describe, expect, it } from "vite-plus/test";

import { searchSettings } from "./settings-search";

const availability = {
  platform: "android",
  hasCloud: true,
  hasEnvironment: true,
  hasProject: false,
};

function targets(query: string, overrides: Partial<typeof availability> = {}) {
  return searchSettings(query, { ...availability, ...overrides }).map((item) => item.target);
}

describe("mobile settings search", () => {
  it("finds settings by names within their pages", () => {
    expect(targets("font size")).toEqual(["SettingsAppearance"]);
    expect(targets("auto-settle")).toEqual(["SettingsThreads"]);
    expect(targets("branch naming")).toEqual(["SettingsEnvironmentSourceControl"]);
    expect(targets("response streaming")).toEqual(["SettingsEnvironmentAgentBehavior"]);
  });

  it("matches case, accents, punctuation, and tokens in any order", () => {
    expect(targets("  FÓNT   size  ")).toEqual(["SettingsAppearance"]);
    expect(targets("size appearance")).toEqual(["SettingsAppearance"]);
    expect(targets("follow ups")).toEqual(["SettingsFollowUp"]);
    expect(targets("appearance unknown")).toEqual([]);
  });

  it("ranks page title matches before keyword matches", () => {
    expect(targets("usage")).toEqual(["SettingsUsage", "SettingsThreads"]);
    expect(targets("legal")).toEqual(["SettingsLegal", "SettingsOpenSourceLicenses"]);
  });

  it("finds nested pages without navigating through About", () => {
    expect(targets("clear cache")).toEqual(["SettingsClientStorage"]);
    expect(targets("logs")).toEqual(["SettingsDiagnostics"]);
    expect(targets("privacy")).toEqual(["SettingsLegal"]);
  });

  it("excludes settings hidden on Android and in local builds", () => {
    expect(targets("microphone")).toEqual([]);
    expect(targets("keyboard")).toEqual([]);
    expect(targets("microphone", { platform: "ios" })).toEqual(["SettingsMicrophone"]);
    expect(targets("keyboard", { platform: "ios" })).toEqual(["SettingsKeyboard"]);
    expect(targets("notifications", { hasCloud: false })).toEqual([]);
    expect(targets("T3 Account", { hasCloud: false })).toEqual([]);
    expect(targets("notifications")).toEqual(["SettingsNotifications"]);
    expect(targets("T3 Account")).toEqual(["SettingsAuth"]);
  });

  it("respects the selected environment and project scope", () => {
    expect(targets("source control", { hasEnvironment: false })).toEqual([]);
    expect(targets("provider accounts", { hasEnvironment: false })).toEqual([]);
    expect(targets("project overview")).toEqual([]);
    expect(targets("project overview", { hasProject: true })).toEqual(["SettingsProjectOverview"]);
    expect(targets("font size", { hasEnvironment: false })).toEqual(["SettingsAppearance"]);
  });

  it("returns no results for empty or unmatched queries", () => {
    expect(targets("")).toEqual([]);
    expect(targets("  ")).toEqual([]);
    expect(targets("---")).toEqual([]);
    expect(targets("not a setting")).toEqual([]);
  });
});

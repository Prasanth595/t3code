import { DEFAULT_SNOOZE_PRESETS, type SnoozePreferences } from "@t3tools/contracts/settings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ snoozePreferences: null as SnoozePreferences }));

vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => state,
}));

import { resolveSnoozePresetSelection, resolveSnoozePresets } from "./Sidebar.snooze";

beforeEach(() => {
  state.snoozePreferences = null;
});

describe("resolveSnoozePresetSelection", () => {
  it("rejects a custom preset that becomes a duplicate while the menu is open", () => {
    state.snoozePreferences = [
      { mode: "absolute", day: "today", time: "09:00" },
      { mode: "relative", hours: 3 },
      ...DEFAULT_SNOOZE_PRESETS.slice(2),
    ];
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 5), "12-hour");

    expect(
      resolveSnoozePresetSelection(
        "snooze:preset-1",
        displayedPresets,
        new Date(2026, 4, 8, 6),
        "12-hour",
      ),
    ).toBeUndefined();
  });

  it("retains a still-valid evening preset after the one-hour cutoff", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 16, 59), "12-hour");

    const selected = resolveSnoozePresetSelection(
      "snooze:evening",
      displayedPresets,
      new Date(2026, 4, 8, 17, 1),
      "12-hour",
    );

    expect(selected?.snoozedUntil).toBe(new Date(2026, 4, 8, 18).toISOString());
  });

  it("does not reuse the evening preset once its wake time has arrived", () => {
    const displayedPresets = resolveSnoozePresets(new Date(2026, 4, 8, 16, 59), "12-hour");

    expect(
      resolveSnoozePresetSelection(
        "snooze:evening",
        displayedPresets,
        new Date(2026, 4, 8, 18),
        "12-hour",
      ),
    ).toBeUndefined();
  });
});

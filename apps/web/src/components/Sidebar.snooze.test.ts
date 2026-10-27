import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => ({ snoozePreferences: null }),
}));

import { resolveSnoozePresetSelection, resolveSnoozePresets } from "./Sidebar.snooze";

describe("resolveSnoozePresetSelection", () => {
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

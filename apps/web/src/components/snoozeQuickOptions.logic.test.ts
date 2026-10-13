import type { SnoozeQuickOption } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveSnoozePresets } from "./Sidebar.snooze";
import {
  BUILT_IN_SNOOZE_QUICK_OPTIONS,
  parseSnoozeTime,
  resolveSnoozeQuickOptions,
  snoozeQuickOptionLabel,
  withSnoozeQuickOptionLabel,
  withSnoozeQuickOptionWhen,
} from "./snoozeQuickOptions.logic";

// Local-time constructor so the snooze math is timezone-stable in tests.
function localDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

const resolve = (options: ReadonlyArray<SnoozeQuickOption>, now: Date) =>
  resolveSnoozeQuickOptions(options, now, "locale");

describe("resolveSnoozeQuickOptions", () => {
  it("gives the built-in options the same wake times and labels as the built-in menu", () => {
    for (const now of [
      localDate(2026, 4, 8, 10), // Wednesday morning: every option.
      localDate(2026, 4, 8, 17, 30), // Less than an hour before the evening.
      localDate(2026, 4, 12, 10), // Sunday: "Next week" is tomorrow morning.
    ]) {
      const builtIn = resolveSnoozePresets(now, "locale");
      const custom = resolve(BUILT_IN_SNOOZE_QUICK_OPTIONS, now);
      expect(custom.map((preset) => [preset.label, preset.snoozedUntil])).toEqual(
        builtIn.map((preset) => [preset.label, preset.snoozedUntil]),
      );
    }
  });

  it("snoozes for minutes and hours, and for calendar days at the same clock time", () => {
    const now = localDate(2026, 4, 8, 10, 15);
    const [minutes, hours, days] = resolve(
      [
        { _tag: "in", amount: 45, unit: "minutes" },
        { _tag: "in", amount: 2, unit: "hours" },
        { _tag: "in", amount: 2, unit: "days" },
      ],
      now,
    );
    expect(Date.parse(minutes!.snoozedUntil) - now.getTime()).toBe(45 * 60_000);
    expect(Date.parse(hours!.snoozedUntil) - now.getTime()).toBe(2 * 3_600_000);
    expect(new Date(days!.snoozedUntil)).toEqual(localDate(2026, 4, 10, 10, 15));
  });

  it("wakes on the next given weekday, a week out on that weekday itself", () => {
    const monday = { _tag: "at", day: "monday", time: { hour: 8, minute: 30 } } as const;
    expect(new Date(resolve([monday], localDate(2026, 4, 8, 10))[0]!.snoozedUntil)).toEqual(
      localDate(2026, 4, 13, 8, 30),
    );
    expect(new Date(resolve([monday], localDate(2026, 4, 13, 7))[0]!.snoozedUntil)).toEqual(
      localDate(2026, 4, 20, 8, 30),
    );
  });

  it("leaves out an option that lands on the time of an earlier one, and keeps setting ids", () => {
    const presets = resolve(
      [
        { _tag: "in", amount: 1, unit: "days" },
        { _tag: "in", amount: 24, unit: "hours" },
        { _tag: "in", amount: 2, unit: "hours" },
      ],
      localDate(2026, 4, 8, 10),
    );
    expect(presets.map((preset) => preset.id)).toEqual(["custom-0", "custom-2"]);
  });

  it("pairs a label that names the day with the time alone, and other labels with the day", () => {
    const now = localDate(2026, 4, 8, 10);
    const tomorrow = { _tag: "at", day: "tomorrow", time: { hour: 9, minute: 0 } } as const;
    const [plain] = resolve([tomorrow], now);
    const [named] = resolve([{ ...tomorrow, label: "Early start" }], now);
    expect(plain!.whenLabel.toLowerCase()).not.toContain("tomorrow");
    expect(named!.whenLabel.toLowerCase()).toContain("tomorrow");
  });
});

describe("snooze quick option labels", () => {
  it("names durations in the singular and plural, and days by name", () => {
    expect(snoozeQuickOptionLabel({ _tag: "in", amount: 1, unit: "hours" })).toBe("In 1 hour");
    expect(snoozeQuickOptionLabel({ _tag: "in", amount: 30, unit: "minutes" })).toBe(
      "In 30 minutes",
    );
    expect(
      snoozeQuickOptionLabel({ _tag: "at", day: "friday", time: { hour: 9, minute: 0 } }),
    ).toBe("Friday");
  });

  it("sets a custom label, and drops it for blank text", () => {
    const option = { _tag: "in", amount: 1, unit: "hours" } as const;
    const named = withSnoozeQuickOptionLabel(option, "  Coffee  ");
    expect(named.label).toBe("Coffee");
    expect(withSnoozeQuickOptionLabel(named, " ")).toStrictEqual(option);
  });
});

describe("snooze quick option editing", () => {
  it("keeps the label and the time when the day changes, and starts a new kind from a default", () => {
    const evening = {
      _tag: "at",
      day: "today",
      time: { hour: 18, minute: 0 },
      label: "Evening",
    } as const;
    expect(withSnoozeQuickOptionWhen(evening, "friday")).toStrictEqual({
      ...evening,
      day: "friday",
    });
    expect(withSnoozeQuickOptionWhen(evening, "in")).toStrictEqual({
      _tag: "in",
      amount: 1,
      unit: "hours",
      label: "Evening",
    });
  });

  it("reads time input values and rejects anything else", () => {
    expect(parseSnoozeTime("09:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseSnoozeTime("18:30:00")).toEqual({ hour: 18, minute: 30 });
    expect(parseSnoozeTime("24:00")).toBeNull();
    expect(parseSnoozeTime("")).toBeNull();
    expect(parseSnoozeTime("9")).toBeNull();
  });
});

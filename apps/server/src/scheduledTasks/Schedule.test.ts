import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it.each([
    ["2026-01-14T18:00:00Z", 15, "2026-01-15T14:00:00.000Z"],
    ["2026-01-15T14:00:00Z", 15, "2026-02-15T14:00:00.000Z"],
    ["2026-01-31T15:00:00Z", 31, "2026-03-31T13:00:00.000Z"],
    ["2026-04-01T00:00:00Z", 31, "2026-05-31T13:00:00.000Z"],
    ["2027-02-01T00:00:00Z", 29, "2027-03-29T13:00:00.000Z"],
    ["2028-02-01T00:00:00Z", 29, "2028-02-29T14:00:00.000Z"],
    ["2026-12-31T15:00:00Z", 1, "2027-01-01T14:00:00.000Z"],
  ])("finds the monthly run after %s for day %s", (from, dayOfMonth, expected) => {
    const next = nextScheduledRunAt(
      { type: "monthly", dayOfMonth, timeOfDay: "09:00" },
      DateTime.makeZonedUnsafe(from, { timeZone: "America/New_York" }),
    );
    expect(next && DateTime.formatIso(next)).toBe(expected);
  });

  it("compares monthly days and applies the fixed-time missed-run grace", () => {
    const schedule = { type: "monthly", dayOfMonth: 15, timeOfDay: "09:00" } as const;
    expect(isSameSchedule(schedule, { ...schedule, timeOfDay: "9:00" })).toBe(true);
    expect(isSameSchedule(schedule, { ...schedule, dayOfMonth: 16 })).toBe(false);
    expect(isSameSchedule(schedule, { ...schedule, timeOfDay: "10:00" })).toBe(false);
    expect(isSameSchedule(schedule, { type: "fixed_time", timeOfDay: "09:00" })).toBe(false);
    expect(isSameSchedule({ type: "fixed_time", timeOfDay: "09:00" }, schedule)).toBe(false);
    const due = DateTime.makeUnsafe("2026-01-15T09:00:00Z");
    expect(isMissedFixedTimeRun(schedule, due, DateTime.add(due, { minutes: 10 }))).toBe(false);
    expect(isMissedFixedTimeRun(schedule, due, DateTime.add(due, { minutes: 11 }))).toBe(true);
  });

  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from "@effect/vitest";

import type { MuseSubscriptionUsage } from "./protocol.ts";
import { museSubscriptionUsageToLimits, museSubscriptionUsageToUpdate } from "./usageLimits.ts";

const NOW_MS = Date.parse("2026-10-12T12:00:00.000Z");
const CHECKED_AT = "2026-10-12T12:00:00.000Z";

const usage: MuseSubscriptionUsage = {
  observedAtMs: NOW_MS,
  tier: "meta-subscription",
  window: {
    usedPercent: 3,
    resetsAtMs: Date.parse("2026-10-12T14:19:00.000Z"),
    windowDurationMins: 300,
  },
  weekly: {
    usedPercent: 46,
    resetsAtMs: Date.parse("2026-10-19T00:00:00.000Z"),
  },
};

describe("Muse subscription usage limits", () => {
  it("maps the session and weekly windows Muse reports", () => {
    expect(museSubscriptionUsageToLimits({ usage, checkedAt: CHECKED_AT, nowMs: NOW_MS })).toEqual({
      checkedAt: CHECKED_AT,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent: 3,
          windowDurationMins: 300,
          resetsAt: "2026-10-12T14:19:00.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 46,
          windowDurationMins: 10080,
          resetsAt: "2026-10-19T00:00:00.000Z",
        },
      ],
    });
  });

  it("starts a window over empty once its reset has passed", () => {
    const limits = museSubscriptionUsageToLimits({
      usage: {
        ...usage,
        window: { ...usage.window, usedPercent: 97, resetsAtMs: NOW_MS - 1 },
      },
      checkedAt: CHECKED_AT,
      nowMs: NOW_MS,
    });
    expect(limits.windows[0]).toEqual({
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: 0,
      windowDurationMins: 300,
    });
    expect(limits.windows[1]?.usedPercent).toBe(46);
  });

  it("clamps over-quota percentages to the contract range and reuses the windows for live updates", () => {
    const update = museSubscriptionUsageToUpdate({
      usage: { ...usage, weekly: { ...usage.weekly, usedPercent: 130 } },
      nowMs: NOW_MS,
    });
    expect(update.windows.map((window) => window.usedPercent)).toEqual([3, 100]);
  });
});

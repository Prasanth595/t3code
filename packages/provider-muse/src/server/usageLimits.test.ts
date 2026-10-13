import { describe, expect, it } from "@effect/vitest";

import { applyUsageLimitsUpdate } from "@t3tools/provider-core/server/usageLimits";
import type { MuseSubscriptionUsage } from "./protocol.ts";
import {
  isNewerMuseUsageReport,
  museSubscriptionUsageToLimits,
  museSubscriptionUsageToUpdate,
} from "./usageLimits.ts";

const NOW_MS = Date.parse("2026-10-12T12:00:00.000Z");

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
  it("maps the session and weekly windows, dated when Meta reported them", () => {
    expect(museSubscriptionUsageToLimits({ usage, nowMs: NOW_MS })).toEqual({
      checkedAt: "2026-10-12T12:00:00.000Z",
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

  it("starts a window over empty once its reset has passed, without touching the other", () => {
    const limits = museSubscriptionUsageToLimits({
      usage: { ...usage, window: { ...usage.window, usedPercent: 97, resetsAtMs: NOW_MS - 1 } },
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

  it("clamps over-quota percentages to the contract range", () => {
    const update = museSubscriptionUsageToUpdate({
      usage: { ...usage, weekly: { ...usage.weekly, usedPercent: 130 } },
      nowMs: NOW_MS,
    });
    expect(update.windows.map((window) => window.usedPercent)).toEqual([3, 100]);
    expect(update.replace).toBe(true);
    expect(update.checkedAt).toBe("2026-10-12T12:00:00.000Z");
  });

  it("clears the stale reset time when a whole-state update replaces an expired window", () => {
    const published = museSubscriptionUsageToLimits({ usage, nowMs: NOW_MS });
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-10-12T15:00:00.000Z",
      replace: true,
      update: museSubscriptionUsageToUpdate({
        usage: {
          ...usage,
          observedAtMs: NOW_MS + 60_000,
          window: { ...usage.window, usedPercent: 97, resetsAtMs: NOW_MS - 1 },
        },
        nowMs: NOW_MS,
      }),
    });
    expect(next?.windows[0]).toEqual({
      id: "session",
      kind: "session",
      label: "Session",
      usedPercent: 0,
      windowDurationMins: 300,
    });
  });

  it("only accepts reports newer than the retained one", () => {
    expect(isNewerMuseUsageReport(undefined, usage)).toBe(true);
    expect(isNewerMuseUsageReport(usage, { ...usage, observedAtMs: NOW_MS + 1 })).toBe(true);
    expect(isNewerMuseUsageReport(usage, { ...usage, observedAtMs: NOW_MS })).toBe(false);
    expect(isNewerMuseUsageReport(usage, { ...usage, observedAtMs: NOW_MS - 1 })).toBe(false);
  });
});

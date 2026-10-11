import { describe, expect, it } from "@effect/vitest";

import type { MuseSubscriptionUsage } from "./protocol.ts";
import { isMuseUsageLimitFailure, museUsageLimitResetAt } from "./usageLimits.ts";

// What Meta reported after a reply on 2026-10-08, as Muse forwards it.
const usage = {
  observedAtMs: 1791447762610,
  tier: "tier-1",
  window: { usedPercent: 0, windowDurationMins: 300, resetsAtMs: 1791465557000 },
  weekly: { usedPercent: 5, resetsAtMs: 1791763200000 },
} satisfies MuseSubscriptionUsage;
const nowMs = usage.observedAtMs;

describe("Muse usage limit failures", () => {
  it("recognizes Meta's quota refusal and no other failure", () => {
    expect(
      isMuseUsageLimitFailure(
        "API error 429: Subscription quota exhausted. Your usage window resets soon. (rate_limit_error)",
      ),
    ).toBe(true);
    // A plain rate limit retries on its own; it is not a used-up subscription window.
    expect(isMuseUsageLimitFailure("API error 429: Rate limit exceeded. (rate_limit_error)")).toBe(
      false,
    );
    expect(isMuseUsageLimitFailure("Subscription quota exhausted.")).toBe(false);
    expect(isMuseUsageLimitFailure(undefined)).toBe(false);
  });

  it("resumes once every exhausted window has reset", () => {
    const sessionOut = { ...usage, window: { ...usage.window, usedPercent: 103 } };
    expect(museUsageLimitResetAt(sessionOut, nowMs)).toBe("2026-10-08T13:19:17.000Z");
    const bothOut = { ...sessionOut, weekly: { ...usage.weekly, usedPercent: 100 } };
    expect(museUsageLimitResetAt(bothOut, nowMs)).toBe("2026-10-12T00:00:00.000Z");
  });

  it("has no reset time unless a report shows a used-up window that resets later", () => {
    expect(museUsageLimitResetAt(undefined, nowMs)).toBeNull();
    expect(museUsageLimitResetAt(usage, nowMs)).toBeNull();
    const sessionOut = { ...usage, window: { ...usage.window, usedPercent: 100 } };
    expect(museUsageLimitResetAt(sessionOut, usage.window.resetsAtMs)).toBeNull();
  });
});

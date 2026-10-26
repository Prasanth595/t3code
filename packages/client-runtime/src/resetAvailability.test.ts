import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resetAvailability } from "./resetAvailability.ts";

const limits = (extra: Partial<ServerProviderUsageLimits>): ServerProviderUsageLimits => ({
  checkedAt: "2026-10-24T22:38:00.000Z",
  windows: [],
  ...extra,
});

describe("resetAvailability", () => {
  it("stays silent for sources that do not report the weekly reset", () => {
    expect(resetAvailability(limits({}))).toBeNull();
    expect(resetAvailability(limits({ resetCredits: { availableCount: 0 } }))).toBeNull();
    expect(resetAvailability(limits({ resetCredits: { availableCount: 2 } }))).toBeNull();
  });

  it("shows a known yes even when the other half is unknown", () => {
    expect(resetAvailability(limits({ atLimitReset: { available: true } }))).toEqual({
      weekly: true,
      banked: null,
      unavailable: null,
    });
    const banked = { availableCount: 2, nextExpiresAt: "2026-10-28T22:38:00.000Z" };
    expect(
      resetAvailability(limits({ atLimitReset: { available: null }, resetCredits: banked })),
    ).toEqual({ weekly: false, banked, unavailable: null });
  });

  it("does not call a weekly reset unavailable when banked credits are zero", () => {
    expect(
      resetAvailability(
        limits({ atLimitReset: { available: true }, resetCredits: { availableCount: 0 } }),
      ),
    ).toEqual({ weekly: true, banked: null, unavailable: null });
  });

  it("shows both when both are available", () => {
    const banked = { availableCount: 1 };
    expect(
      resetAvailability(limits({ atLimitReset: { available: true }, resetCredits: banked })),
    ).toEqual({ weekly: true, banked, unavailable: null });
  });

  it("says none only when both halves are confirmed empty", () => {
    expect(
      resetAvailability(
        limits({ atLimitReset: { available: false }, resetCredits: { availableCount: 0 } }),
      ),
    ).toEqual({ weekly: false, banked: null, unavailable: "No reset available" });
  });

  it("never reads a missing half as none", () => {
    for (const reported of [
      limits({ atLimitReset: { available: false } }),
      limits({ atLimitReset: { available: null }, resetCredits: { availableCount: 0 } }),
      limits({ atLimitReset: { available: null } }),
    ]) {
      expect(resetAvailability(reported)).toEqual({
        weekly: false,
        banked: null,
        unavailable: "Reset status unknown",
      });
    }
  });
});

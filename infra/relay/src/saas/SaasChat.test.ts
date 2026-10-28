import { describe, expect, it } from "@effect/vitest";

import { chatActivityDays } from "./SaasChat.ts";

describe("chatActivityDays", () => {
  it("lists every day up to today, oldest first, with quiet days as zeros", () => {
    const busy = {
      day: "2026-10-26",
      userMessages: 4,
      anonymousMessages: 2,
      activeUsers: 1,
      activeDevices: 1,
      inputTokens: 900,
      outputTokens: 300,
    };
    const days = chatActivityDays([busy], "2026-10-27", 3);
    expect(days.map((day) => day.day)).toEqual(["2026-10-25", "2026-10-26", "2026-10-27"]);
    expect(days[1]).toEqual(busy);
    expect(days[2]?.userMessages).toBe(0);
  });

  it("crosses month ends", () => {
    expect(chatActivityDays([], "2026-11-01", 2).map((day) => day.day)).toEqual([
      "2026-10-31",
      "2026-11-01",
    ]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { orderUsageDrivers, usageRefreshDelay } from "./threadUsagePanel.logic";

describe("usageRefreshDelay", () => {
  it("runs the first refresh at once", () => {
    expect(usageRefreshDelay(null, 1_000)).toBe(0);
  });

  it("holds a refresh asked for inside the interval until it has passed", () => {
    expect(usageRefreshDelay(10_000, 25_000, 30_000)).toBe(15_000);
  });

  it("runs at once when the interval has passed", () => {
    expect(usageRefreshDelay(10_000, 40_000, 30_000)).toBe(0);
    expect(usageRefreshDelay(10_000, 99_000, 30_000)).toBe(0);
  });
});

describe("orderUsageDrivers", () => {
  const rank = (driver: string) => ["codex", "claudeAgent", "cursor"].indexOf(driver);

  it("puts the thread's provider first and keeps the rest in rank order once", () => {
    expect(
      orderUsageDrivers(["cursor", "codex", "claudeAgent", "codex"], "claudeAgent", rank),
    ).toEqual(["claudeAgent", "codex", "cursor"]);
  });

  it("keeps rank order when the thread's provider has no data", () => {
    expect(orderUsageDrivers(["cursor", "codex"], "claudeAgent", rank)).toEqual([
      "codex",
      "cursor",
    ]);
  });
});

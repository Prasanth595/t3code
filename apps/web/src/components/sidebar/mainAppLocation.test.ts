import { describe, expect, it } from "vite-plus/test";

import { isSidebarUtilityPage } from "./mainAppLocation";

describe("isSidebarUtilityPage", () => {
  it("treats Factory and its runs as utility pages", () => {
    expect(isSidebarUtilityPage("/factory")).toBe(true);
    expect(isSidebarUtilityPage("/factory/run-123")).toBe(true);
  });

  it("does not match routes that only share the prefix", () => {
    expect(isSidebarUtilityPage("/factory-floor")).toBe(false);
    expect(isSidebarUtilityPage("/")).toBe(false);
  });
});

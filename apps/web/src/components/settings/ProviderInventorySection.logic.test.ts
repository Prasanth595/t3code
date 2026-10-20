import { describe, expect, it } from "vite-plus/test";

import {
  countDisabledInventory,
  inventoryItemDetail,
  nextDisabledInventory,
} from "./ProviderInventorySection.logic";

describe("nextDisabledInventory", () => {
  it("adds an item when it is switched off and keeps the other kinds", () => {
    expect(
      nextDisabledInventory({ plugins: ["design@synced"] }, "connectors", "claude.ai Gmail", false),
    ).toEqual({ connectors: ["claude.ai Gmail"], plugins: ["design@synced"] });
  });

  it("does not add the same item twice", () => {
    expect(nextDisabledInventory({ skills: ["pdf"] }, "skills", "pdf", false)).toEqual({
      skills: ["pdf"],
    });
  });

  it("drops the setting once the last item is switched back on", () => {
    expect(nextDisabledInventory({ skills: ["pdf"] }, "skills", "pdf", true)).toBeUndefined();
  });

  it("drops an emptied kind but keeps the rest", () => {
    expect(
      nextDisabledInventory({ skills: ["pdf"], plugins: ["design@synced"] }, "skills", "pdf", true),
    ).toEqual({ plugins: ["design@synced"] });
  });
});

describe("countDisabledInventory", () => {
  it("counts every switched-off item", () => {
    expect(countDisabledInventory(undefined)).toBe(0);
    expect(countDisabledInventory({ connectors: ["a", "b"], skills: ["c"] })).toBe(3);
  });
});

describe("inventoryItemDetail", () => {
  it("joins status, tool count and owning plugin", () => {
    expect(
      inventoryItemDetail({
        id: "plugin:design:linear",
        name: "linear",
        status: "needsAuth",
        plugin: "design",
      }),
    ).toBe("Needs sign-in · from design");
    expect(inventoryItemDetail({ id: "g", name: "Gmail", status: "connected", toolCount: 1 })).toBe(
      "Connected · 1 tool",
    );
    expect(inventoryItemDetail({ id: "pdf", name: "pdf" })).toBeNull();
  });
});

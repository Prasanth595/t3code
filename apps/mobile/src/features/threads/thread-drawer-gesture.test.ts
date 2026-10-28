import { describe, expect, it } from "vite-plus/test";
import { drawerDragProgress, drawerShouldOpen } from "./thread-drawer-gesture";

describe("thread drawers", () => {
  it("tracks opposite opening directions and ignores outward drags", () => {
    expect(drawerDragProgress("left", 120, 300, false)).toBe(0.4);
    expect(drawerDragProgress("right", -120, 300, false)).toBe(0.4);
    expect(drawerDragProgress("left", -120, 300, false)).toBe(0);
    expect(drawerDragProgress("right", 120, 300, false)).toBe(0);
    expect(drawerDragProgress("right", -500, 300, false)).toBe(1);
  });

  it("tracks closing drags and clamps overscroll", () => {
    expect(drawerDragProgress("left", -120, 300, true)).toBe(0.6);
    expect(drawerDragProgress("right", 120, 300, true)).toBe(0.6);
    expect(drawerDragProgress("right", -120, 300, true)).toBe(1);
    expect(drawerDragProgress("right", 500, 300, true)).toBe(0);
  });

  it("commits a deliberate drag or flick in either direction", () => {
    expect(drawerShouldOpen("left", 110, 0, 300, false)).toBe(true);
    expect(drawerShouldOpen("right", -110, 0, 300, false)).toBe(true);
    expect(drawerShouldOpen("right", -20, -600, 300, false)).toBe(true);
    expect(drawerShouldOpen("right", -20, 0, 300, false)).toBe(false);
    expect(drawerShouldOpen("right", 110, 0, 300, true)).toBe(false);
    expect(drawerShouldOpen("right", 20, 600, 300, true)).toBe(false);
    expect(drawerShouldOpen("right", 20, 0, 300, true)).toBe(true);
    expect(drawerShouldOpen("left", -110, 0, 300, true)).toBe(false);
  });
});

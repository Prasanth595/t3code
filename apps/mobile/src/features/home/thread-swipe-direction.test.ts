import { describe, expect, it } from "vite-plus/test";
import { resolveThreadSwipeRelease } from "./thread-swipe-direction";

describe("thread full swipe direction", () => {
  it("keeps iOS leftward actions and uses the opposite rightward swipe for hiding", () => {
    expect(resolveThreadSwipeRelease(-200, "right", 200, true)).toBe("primary");
    expect(resolveThreadSwipeRelease(200, "right", 200, true)).toBe("opposite");
    expect(resolveThreadSwipeRelease(199, "right", 200, true)).toBeNull();
  });

  it("keeps Android phone rightward actions without claiming drawer-close swipes", () => {
    expect(resolveThreadSwipeRelease(200, "left", 200, false)).toBe("primary");
    expect(resolveThreadSwipeRelease(-200, "left", 200, false)).toBeNull();
    expect(resolveThreadSwipeRelease(-200, "left", 200, true)).toBe("opposite");
  });
});

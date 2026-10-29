import { describe, expect, it } from "vite-plus/test";

import {
  advanceSwipeGesture,
  committedSwipeDirection,
  IDLE_SWIPE_GESTURE,
  scrollerClaimsSwipe,
  SWIPE_NAVIGATION_THRESHOLD,
  swipeGestureCoasting,
  type SwipeGesture,
  type SwipeNavigationDirection,
} from "./swipeNavigation";

function feed(
  deltas: readonly (readonly [number, number])[],
  canStart: (direction: SwipeNavigationDirection) => boolean = () => true,
): SwipeGesture {
  return deltas.reduce<SwipeGesture>(
    (gesture, [deltaX, deltaY]) => advanceSwipeGesture(gesture, deltaX, deltaY, canStart),
    IDLE_SWIPE_GESTURE,
  );
}

describe("advanceSwipeGesture", () => {
  it("commits a horizontal swipe only once it passes the threshold", () => {
    const short = feed([
      [-10, 1],
      [-60, 2],
      [-60, 0],
    ]);
    expect(short).toMatchObject({ phase: "tracking", direction: "back" });
    expect(committedSwipeDirection(short)).toBeNull();

    expect(committedSwipeDirection(advanceSwipeGesture(short, -20, 0, () => true))).toBe("back");
    expect(
      committedSwipeDirection(
        feed([
          [80, 0],
          [80, 0],
        ]),
      ),
    ).toBe("forward");
  });

  it("waits out jitter before locking the axis", () => {
    const starts: SwipeNavigationDirection[] = [];
    const gesture = feed(
      [
        [3, 2],
        [-2, 3],
        [-30, 1],
      ],
      (direction) => {
        starts.push(direction);
        return true;
      },
    );
    expect(gesture).toMatchObject({ phase: "tracking", direction: "back" });
    expect(starts).toEqual(["back"]);
  });

  it("ignores the rest of a vertical scroll even when it turns horizontal", () => {
    expect(
      feed([
        [2, 20],
        [-200, 0],
        [-200, 0],
      ]),
    ).toEqual({ phase: "ignored" });
  });

  it("ignores a swipe the app cannot take for the rest of the gesture", () => {
    expect(
      feed(
        [
          [-20, 0],
          [-200, 0],
        ],
        () => false,
      ),
    ).toEqual({ phase: "ignored" });
  });

  it("retracts on reversal without arming the other direction", () => {
    const gesture = feed([
      [-150, 0],
      [400, 0],
    ]);
    expect(gesture).toMatchObject({ phase: "tracking", direction: "back", pull: 0 });
    expect(committedSwipeDirection(gesture)).toBeNull();

    const overshot = feed([
      [-1000, 0],
      [SWIPE_NAVIGATION_THRESHOLD * 0.3, 0],
    ]);
    expect(committedSwipeDirection(overshot)).toBeNull();
  });
});

describe("swipeGestureCoasting", () => {
  it("recognizes momentum by steadily shrinking steps", () => {
    const steps = (values: readonly number[]) => feed(values.map((step) => [-step, 0] as const));
    expect(swipeGestureCoasting(steps([22, 63, 70, 70, 69, 66, 66, 61]))).toBe(true);
    expect(swipeGestureCoasting(steps([48, 48, 45, 45, 43]))).toBe(false);
    expect(swipeGestureCoasting(steps([16, 16, 16, 16, 16, 16, 16]))).toBe(false);
    expect(swipeGestureCoasting(steps([21, 21, 20, 20, 19, 26]))).toBe(false);
    expect(swipeGestureCoasting(steps([20, 19, 14, 12, 9, 8, 8]))).toBe(false);
    expect(swipeGestureCoasting(steps([8, 8, 7, 7, 6, 6, 5]))).toBe(false);
  });
});

describe("scrollerClaimsSwipe", () => {
  const scroller = {
    overflowX: "auto",
    overscrollBehaviorX: "auto",
    rtl: false,
    scrollLeft: 0,
    scrollWidth: 300,
    clientWidth: 100,
  };

  it.each([
    ["ltr at the start", {}, "back", false],
    ["ltr at the start", {}, "forward", true],
    ["ltr at the end", { scrollLeft: 200 }, "back", true],
    ["ltr at the end", { scrollLeft: 200 }, "forward", false],
    ["rtl at the start", { rtl: true }, "back", true],
    ["rtl at the start", { rtl: true }, "forward", false],
    ["rtl at the end", { rtl: true, scrollLeft: -200 }, "back", false],
    ["rtl at the end", { rtl: true, scrollLeft: -200 }, "forward", true],
    ["contained at its edge", { overscrollBehaviorX: "contain" }, "back", true],
    ["hidden overflow", { overflowX: "hidden", scrollLeft: 100 }, "back", false],
    ["no overflow", { scrollWidth: 100 }, "forward", false],
  ] as const)("%s, swiping %s: %s", (_name, overrides, direction, claims) => {
    expect(scrollerClaimsSwipe({ ...scroller, ...overrides }, direction)).toBe(claims);
  });
});

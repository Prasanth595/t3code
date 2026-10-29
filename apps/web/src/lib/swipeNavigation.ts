export type SwipeNavigationDirection = "back" | "forward";

export type SwipeGesture =
  | { readonly phase: "idle" }
  | { readonly phase: "pending"; readonly deltaX: number; readonly deltaY: number }
  | { readonly phase: "ignored" }
  | {
      readonly phase: "tracking";
      readonly direction: SwipeNavigationDirection;
      readonly pull: number;
      readonly steps: readonly number[];
    };

export const SWIPE_NAVIGATION_THRESHOLD = 140;
const MAX_PULL = SWIPE_NAVIGATION_THRESHOLD * 1.25;
const AXIS_DEAD_ZONE = 12;
const HORIZONTAL_AXIS_RATIO = 1.5;
const MOMENTUM_WINDOW = 6;
const MOMENTUM_MIN_STEP = 6;
const MOMENTUM_MIN_DECAY = 0.04;
const MOMENTUM_MAX_DECAY = 0.3;

export const IDLE_SWIPE_GESTURE: SwipeGesture = { phase: "idle" };
export const IGNORED_SWIPE_GESTURE: SwipeGesture = { phase: "ignored" };

/**
 * Feeds one wheel delta into a gesture. The axis and direction lock once the
 * movement leaves the dead zone, and a gesture the app cannot take stays
 * ignored until it ends, as Chrome latches a scroll to one target.
 */
export function advanceSwipeGesture(
  gesture: SwipeGesture,
  deltaX: number,
  deltaY: number,
  canStart: (direction: SwipeNavigationDirection) => boolean,
): SwipeGesture {
  switch (gesture.phase) {
    case "ignored":
      return gesture;
    case "tracking": {
      const step = gesture.direction === "back" ? -deltaX : deltaX;
      return {
        ...gesture,
        pull: Math.min(Math.max(gesture.pull + step, 0), MAX_PULL),
        steps: [...gesture.steps.slice(1 - MOMENTUM_WINDOW), step],
      };
    }
    case "idle":
    case "pending": {
      const totalX = (gesture.phase === "pending" ? gesture.deltaX : 0) + deltaX;
      const totalY = (gesture.phase === "pending" ? gesture.deltaY : 0) + deltaY;
      if (Math.hypot(totalX, totalY) < AXIS_DEAD_ZONE) {
        return { phase: "pending", deltaX: totalX, deltaY: totalY };
      }
      if (Math.abs(totalX) <= Math.abs(totalY) * HORIZONTAL_AXIS_RATIO) {
        return IGNORED_SWIPE_GESTURE;
      }
      // Natural scrolling: fingers moving right report a negative deltaX.
      const direction = totalX < 0 ? "back" : "forward";
      if (!canStart(direction)) return IGNORED_SWIPE_GESTURE;
      return {
        phase: "tracking",
        direction,
        pull: Math.min(Math.abs(totalX), MAX_PULL),
        steps: [Math.abs(totalX)],
      };
    }
  }
}

export function swipeGestureProgress(gesture: SwipeGesture): number {
  return gesture.phase === "tracking" ? gesture.pull / SWIPE_NAVIGATION_THRESHOLD : 0;
}

export function committedSwipeDirection(gesture: SwipeGesture): SwipeNavigationDirection | null {
  return gesture.phase === "tracking" && gesture.pull >= SWIPE_NAVIGATION_THRESHOLD
    ? gesture.direction
    : null;
}

/**
 * The DOM never reports finger lift, and Chromium's scroll end waits out the
 * momentum macOS adds after a flick. Traced on a MacBook, momentum decays
 * smoothly and never grows, fingers jitter, and a finger slowing to reverse
 * drops faster. Slow momentum is too quantized to tell apart, so it waits.
 */
export function swipeGestureCoasting(gesture: SwipeGesture): boolean {
  if (gesture.phase !== "tracking" || gesture.steps.length < MOMENTUM_WINDOW) return false;
  const { steps } = gesture;
  const smooth = steps.every(
    (step, index) => step >= MOMENTUM_MIN_STEP && (index === 0 || step <= steps[index - 1]!),
  );
  const decay = 1 - steps[steps.length - 1]! / steps[0]!;
  return smooth && decay >= MOMENTUM_MIN_DECAY && decay <= MOMENTUM_MAX_DECAY;
}

export interface HorizontalScrollerMetrics {
  readonly overflowX: string;
  readonly overscrollBehaviorX: string;
  readonly rtl: boolean;
  readonly scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/** Whether a scroller under the pointer keeps the swipe from reaching navigation. */
export function scrollerClaimsSwipe(
  scroller: HorizontalScrollerMetrics,
  direction: SwipeNavigationDirection,
): boolean {
  if (!/^(auto|scroll|overlay)$/.test(scroller.overflowX)) return false;
  const range = scroller.scrollWidth - scroller.clientWidth;
  if (range < 1) return false;
  if (scroller.overscrollBehaviorX !== "auto") return true;
  // RTL scrollLeft runs from 0 at the right edge down to -range.
  const fromLeft = scroller.rtl ? range + scroller.scrollLeft : scroller.scrollLeft;
  return direction === "back" ? fromLeft >= 1 : fromLeft <= range - 1;
}

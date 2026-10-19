import { isTimelineScrollTarget } from "./timelineScrollTarget";

const COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX = 24;
export const COMPOSER_SCROLL_GESTURE_RESET_MS = 120;
const POINTER_SCROLL_TAIL_MS = 250;
const POINTER_SCROLL_RELEASE_EVENTS = [
  "pointerup",
  "pointercancel",
  "touchend",
  "touchcancel",
] as const;

export type ComposerScrollGestureState = {
  accumulatedDeltaPx: number;
  collapseSuppressed: boolean;
  lastEventAt: number;
};

export function shouldCollapseComposerForScrollKey(input: {
  key: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  isAtLogicalEnd: boolean;
}): boolean {
  switch (input.key) {
    case "PageUp":
    case "Home":
      return input.scrollTop > 1;
    case "PageDown":
    case "End":
      return !input.isAtLogicalEnd && input.scrollTop < input.scrollHeight - input.clientHeight - 1;
    default:
      return false;
  }
}

export function createComposerScrollGestureState(): ComposerScrollGestureState {
  return {
    accumulatedDeltaPx: 0,
    collapseSuppressed: false,
    lastEventAt: Number.NEGATIVE_INFINITY,
  };
}

export function resetComposerScrollGesture(state: ComposerScrollGestureState): void {
  state.accumulatedDeltaPx = 0;
  state.collapseSuppressed = false;
  state.lastEventAt = Number.NEGATIVE_INFINITY;
}

export function suppressActiveComposerScrollGesture(
  state: ComposerScrollGestureState,
  now: number,
  gestureResetMs: number,
): void {
  if (now - state.lastEventAt <= gestureResetMs) {
    state.collapseSuppressed = true;
  }
}

export function recordComposerScrollGestureEvent(
  state: ComposerScrollGestureState,
  input: {
    now: number;
    deltaPx: number;
    collapseThresholdPx: number;
    collapseEligible: boolean;
    canScrollInGestureDirection: boolean;
    scrollsTowardLogicalEnd: boolean;
  },
): boolean {
  state.lastEventAt = input.now;
  if (
    state.collapseSuppressed ||
    !input.collapseEligible ||
    !input.canScrollInGestureDirection ||
    input.scrollsTowardLogicalEnd
  ) {
    state.accumulatedDeltaPx = 0;
    return false;
  }

  state.accumulatedDeltaPx += input.deltaPx;
  if (state.accumulatedDeltaPx < input.collapseThresholdPx) {
    return false;
  }

  state.accumulatedDeltaPx = 0;
  return true;
}

export function listenForComposerScrollGestures({
  gestureState,
  getTimelineScrollableNode,
  isTimelineAtLogicalEnd,
  isCollapseEligible,
  onCollapse,
  restoreAfterTimelineReachedEnd,
}: {
  gestureState: ComposerScrollGestureState;
  getTimelineScrollableNode: () => HTMLElement | null;
  isTimelineAtLogicalEnd: () => boolean;
  isCollapseEligible: () => boolean;
  onCollapse: () => void;
  restoreAfterTimelineReachedEnd: () => void;
}): () => void {
  let collapseTimeout: number | null = null;
  const finishScrollGesture = () => {
    if (collapseTimeout !== null) {
      window.clearTimeout(collapseTimeout);
    }
    collapseTimeout = null;
    resetComposerScrollGesture(gestureState);
  };
  const recordScrollGestureEvent = (
    input: Omit<Parameters<typeof recordComposerScrollGestureEvent>[1], "collapseThresholdPx">,
  ) => {
    if (collapseTimeout !== null) {
      window.clearTimeout(collapseTimeout);
    }
    collapseTimeout = window.setTimeout(finishScrollGesture, COMPOSER_SCROLL_GESTURE_RESET_MS);
    const shouldCollapse = recordComposerScrollGestureEvent(gestureState, {
      ...input,
      collapseThresholdPx: COMPOSER_SCROLL_COLLAPSE_THRESHOLD_PX,
    });
    if (shouldCollapse) {
      onCollapse();
    }
  };
  const handleTimelineWheel = (event: WheelEvent) => {
    endMiddleClickAutoscroll();
    if (event.ctrlKey || !(event.target instanceof Element)) {
      return;
    }

    const scrollNode = getTimelineScrollableNode();
    if (!scrollNode) return;
    const targetsTimeline = isTimelineScrollTarget(event.target, scrollNode, event.deltaY);
    if (!scrollNode.contains(event.target) && !gestureState.collapseSuppressed) return;

    const canScrollInGestureDirection =
      targetsTimeline &&
      (event.deltaY < 0
        ? scrollNode.scrollTop > 0
        : scrollNode.scrollTop < scrollNode.scrollHeight - scrollNode.clientHeight);
    const deltaPx =
      Math.abs(event.deltaY) *
      (event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? scrollNode.clientHeight
          : 1);
    recordScrollGestureEvent({
      now: window.performance.now(),
      deltaPx,
      collapseEligible: targetsTimeline && isCollapseEligible(),
      canScrollInGestureDirection,
      scrollsTowardLogicalEnd: event.deltaY > 0 && isTimelineAtLogicalEnd(),
    });
  };

  // Scrollbar drags, middle-click autoscroll and touch send no wheel
  // events, so their direction comes from scroll offsets. Only scrolls
  // during the gesture or a short fixed tail after release count, so
  // programmatic scrolls (live follow, turn anchoring) can't collapse the
  // composer. Scrolls don't extend the tail: streaming follow scrolls would
  // keep it open.
  let pointerScrollUntil = 0;
  let lastScrollTop = getTimelineScrollableNode()?.scrollTop ?? null;
  // Middle-click autoscroll keeps going after the button is released, until
  // the next click, key press, or wheel, so its hold ends on those instead.
  let middleClickAutoscroll = false;
  const holdPointerScroll = () => {
    pointerScrollUntil = Number.POSITIVE_INFINITY;
  };
  const releasePointerScroll = (event: Event) => {
    if (middleClickAutoscroll) {
      if (event.type !== "blur") return;
      middleClickAutoscroll = false;
    }
    if (pointerScrollUntil === Number.POSITIVE_INFINITY) {
      pointerScrollUntil = window.performance.now() + POINTER_SCROLL_TAIL_MS;
    }
  };
  const endMiddleClickAutoscroll = () => {
    if (!middleClickAutoscroll) return false;
    middleClickAutoscroll = false;
    pointerScrollUntil = 0;
    return true;
  };
  const handleTimelinePointerDown = (event: PointerEvent) => {
    // The click that stops autoscroll doesn't start a new gesture.
    if (endMiddleClickAutoscroll()) return;
    const scrollNode = getTimelineScrollableNode();
    if (!scrollNode || !(event.target instanceof Node)) return;
    if (event.button === 1 && scrollNode.contains(event.target)) {
      middleClickAutoscroll = true;
      holdPointerScroll();
    } else if (event.target === scrollNode) {
      // Only scrollbar presses target the scroll node itself.
      holdPointerScroll();
    }
  };
  const handleTimelineTouchMove = (event: TouchEvent) => {
    const scrollNode = getTimelineScrollableNode();
    if (scrollNode && event.target instanceof Node && scrollNode.contains(event.target)) {
      holdPointerScroll();
    }
  };
  const handleTimelineScroll = (event: Event) => {
    const scrollNode = getTimelineScrollableNode();
    if (!scrollNode || event.target !== scrollNode) return;
    const scrollTop = scrollNode.scrollTop;
    const deltaY = lastScrollTop === null ? 0 : scrollTop - lastScrollTop;
    lastScrollTop = scrollTop;
    const now = window.performance.now();
    if (deltaY === 0 || now >= pointerScrollUntil) return;

    // This capture listener runs before the list records the new offset,
    // so the list's end state can lag by one scroll step.
    const atLogicalEnd =
      deltaY > 0 &&
      (scrollNode.scrollHeight - scrollTop - scrollNode.clientHeight <= 1 ||
        isTimelineAtLogicalEnd());
    if (atLogicalEnd) {
      restoreAfterTimelineReachedEnd();
    }
    recordScrollGestureEvent({
      now,
      deltaPx: Math.abs(deltaY),
      collapseEligible: isCollapseEligible(),
      // The offset already moved, so the timeline could scroll this way.
      canScrollInGestureDirection: true,
      scrollsTowardLogicalEnd: atLogicalEnd,
    });
  };

  document.addEventListener("wheel", handleTimelineWheel, { capture: true, passive: true });
  // Scroll events don't bubble, so a capture listener is the only document-
  // level way to hear the timeline's.
  document.addEventListener("scroll", handleTimelineScroll, { capture: true, passive: true });
  document.addEventListener("pointerdown", handleTimelinePointerDown, {
    capture: true,
    passive: true,
  });
  document.addEventListener("touchmove", handleTimelineTouchMove, {
    capture: true,
    passive: true,
  });
  document.addEventListener("keydown", endMiddleClickAutoscroll, { capture: true });
  // Capture so a handler that stops propagation can't leave the hold stuck.
  for (const type of POINTER_SCROLL_RELEASE_EVENTS) {
    window.addEventListener(type, releasePointerScroll, { capture: true, passive: true });
  }
  // A drag interrupted by switching windows may never deliver its pointerup.
  window.addEventListener("blur", releasePointerScroll);
  return () => {
    document.removeEventListener("wheel", handleTimelineWheel, true);
    document.removeEventListener("scroll", handleTimelineScroll, true);
    document.removeEventListener("pointerdown", handleTimelinePointerDown, true);
    document.removeEventListener("touchmove", handleTimelineTouchMove, true);
    document.removeEventListener("keydown", endMiddleClickAutoscroll, true);
    for (const type of POINTER_SCROLL_RELEASE_EVENTS) {
      window.removeEventListener(type, releasePointerScroll, true);
    }
    window.removeEventListener("blur", releasePointerScroll);
    finishScrollGesture();
  };
}

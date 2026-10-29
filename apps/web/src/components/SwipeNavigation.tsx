import { useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import {
  advanceSwipeGesture,
  committedSwipeDirection,
  IDLE_SWIPE_GESTURE,
  IGNORED_SWIPE_GESTURE,
  scrollerClaimsSwipe,
  swipeGestureCoasting,
  swipeGestureProgress,
  type SwipeGesture,
  type SwipeNavigationDirection,
} from "../lib/swipeNavigation";
import { isModelPickerOpen } from "../modelPickerVisibility";

const BUBBLE_SIZE = 72;
const MAX_SCRIM_OPACITY = 0.5;
const EXIT_MS = 150;
// Chromium ends a scroll sequence on finger lift, or once momentum stops. This
// only clears an indicator whose end signal never came.
const STALE_GESTURE_MS = 2000;

function canStartSwipe(event: WheelEvent, direction: SwipeNavigationDirection): boolean {
  if (direction === "back" ? !window.navigation.canGoBack : !window.navigation.canGoForward) {
    return false;
  }
  if (isCommandPaletteOpen() || isModelPickerOpen()) return false;
  for (const target of event.composedPath()) {
    if (!(target instanceof Element)) continue;
    if (target.matches('[role="dialog"], [role="alertdialog"]')) return false;
    if (target.scrollWidth - target.clientWidth < 1) continue;
    const style = getComputedStyle(target);
    const scroller = {
      overflowX: style.overflowX,
      overscrollBehaviorX: style.overscrollBehaviorX,
      rtl: style.direction === "rtl",
      scrollLeft: target.scrollLeft,
      scrollWidth: target.scrollWidth,
      clientWidth: target.clientWidth,
    };
    if (scrollerClaimsSwipe(scroller, direction)) return false;
  }
  return true;
}

/** Chrome-style two-finger swipe through history, for the macOS desktop app. */
export function SwipeNavigation() {
  const router = useRouter();
  const overlayRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds window wheel input and the desktop scroll-end signal for the swipe gesture
  useEffect(() => {
    const bridge = window.desktopBridge;
    const overlay = overlayRef.current;
    const scrim = scrimRef.current;
    const bubble = bubbleRef.current;
    if (typeof bridge?.getSwipeNavigationEnabled !== "function" || !overlay || !scrim || !bubble) {
      return;
    }
    let enabled = bridge.getSwipeNavigationEnabled();
    let gesture: SwipeGesture = IDLE_SWIPE_GESTURE;
    let frame = 0;
    let staleTimer: number | undefined;
    let exitTimer: number | undefined;

    const bubbleTranslate = (direction: SwipeNavigationDirection, hiddenBy: number) =>
      `${direction === "back" ? -hiddenBy : hiddenBy}px -50%`;

    const paint = () => {
      frame = 0;
      if (gesture.phase !== "tracking") return;
      const progress = Math.min(swipeGestureProgress(gesture), 1);
      const armed = progress >= 1;
      bubble.style.translate = bubbleTranslate(
        gesture.direction,
        BUBBLE_SIZE - (progress * BUBBLE_SIZE) / 2,
      );
      bubble.style.opacity = String(armed ? 1 : 0.4 + 0.5 * progress);
      bubble.dataset.armed = String(armed);
      scrim.style.opacity = String(progress * MAX_SCRIM_OPACITY);
    };

    const show = (direction: SwipeNavigationDirection) => {
      window.clearTimeout(exitTimer);
      const rect = document.querySelector('[data-slot="sidebar-inset"]')?.getBoundingClientRect();
      overlay.style.left = `${rect?.left ?? 0}px`;
      overlay.style.top = `${rect?.top ?? 0}px`;
      overlay.style.width = rect ? `${rect.width}px` : "100vw";
      overlay.style.height = rect ? `${rect.height}px` : "100vh";
      overlay.dataset.direction = direction;
      overlay.dataset.state = "tracking";
      bubble.style.translate = bubbleTranslate(direction, BUBBLE_SIZE);
      bubble.dataset.armed = "false";
      overlay.hidden = false;
    };

    const release = (next: SwipeGesture, commit: boolean) => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      const tracked = gesture.phase === "tracking" ? gesture : null;
      gesture = next;
      if (!tracked) return;
      const direction = commit ? committedSwipeDirection(tracked) : null;
      if (direction === "back") window.history.back();
      if (direction === "forward") window.history.forward();
      overlay.dataset.state = "exiting";
      if (!direction) bubble.style.translate = bubbleTranslate(tracked.direction, BUBBLE_SIZE);
      bubble.style.opacity = "0";
      scrim.style.opacity = "0";
      exitTimer = window.setTimeout(() => {
        overlay.hidden = true;
      }, EXIT_MS);
    };

    // The rest of an abandoned scroll, momentum included, must not start another swipe.
    const abandon = () =>
      release(gesture.phase === "idle" ? IDLE_SWIPE_GESTURE : IGNORED_SWIPE_GESTURE, false);

    const onWheel = (event: WheelEvent) => {
      if (!enabled) return;
      window.clearTimeout(staleTimer);
      staleTimer = window.setTimeout(() => release(IDLE_SWIPE_GESTURE, false), STALE_GESTURE_MS);
      if (gesture.phase === "ignored") return;
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL
      ) {
        release(IGNORED_SWIPE_GESTURE, false);
        return;
      }
      const wasTracking = gesture.phase === "tracking";
      gesture = advanceSwipeGesture(gesture, event.deltaX, event.deltaY, (direction) =>
        canStartSwipe(event, direction),
      );
      if (gesture.phase !== "tracking") return;
      if (!wasTracking) show(gesture.direction);
      if (committedSwipeDirection(gesture) && swipeGestureCoasting(gesture)) {
        release(IGNORED_SWIPE_GESTURE, true);
        return;
      }
      if (!frame) frame = window.requestAnimationFrame(paint);
    };
    const onVisibilityChange = () => {
      if (document.hidden) abandon();
    };
    const onFocus = () => {
      enabled = bridge.getSwipeNavigationEnabled();
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("blur", abandon);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const stopScrollEnd = bridge.onTrackpadScrollEnd(() => {
      window.clearTimeout(staleTimer);
      release(IDLE_SWIPE_GESTURE, true);
    });
    const stopRouteWatch = router.subscribe("onBeforeNavigate", abandon);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("blur", abandon);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopScrollEnd();
      stopRouteWatch();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(staleTimer);
      window.clearTimeout(exitTimer);
    };
  }, [router]);

  return (
    <div
      ref={overlayRef}
      hidden
      aria-hidden
      className="group pointer-events-none fixed z-40 overflow-hidden"
    >
      <div
        ref={scrimRef}
        className="absolute inset-0 bg-background opacity-0 group-data-[state=exiting]:transition-opacity group-data-[state=exiting]:duration-150"
      />
      <div
        ref={bubbleRef}
        className="absolute top-1/2 flex size-18 scale-90 items-center rounded-full border border-sidebar-border bg-sidebar surface-grain px-1.5 text-sidebar-foreground shadow-lg transition-[scale] duration-150 group-data-[direction=back]:left-0 group-data-[direction=back]:justify-end group-data-[direction=forward]:right-0 group-data-[direction=forward]:justify-start group-data-[state=exiting]:transition-[translate,opacity,scale] data-[armed=true]:scale-100"
      >
        <ArrowLeftIcon className="size-6 group-data-[direction=forward]:hidden" />
        <ArrowRightIcon className="size-6 group-data-[direction=back]:hidden" />
      </div>
    </div>
  );
}

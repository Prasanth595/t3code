import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

type ThreadSwipeDirection = "previous" | "next";
type ThreadSwipeGesture = {
  direction: ThreadSwipeDirection;
  progress: number;
};

const SWIPE_THRESHOLD_PX = 120;
const SWIPE_IDLE_MS = 180;

function canScrollHorizontally(path: ReadonlyArray<EventTarget>): boolean {
  for (const target of path) {
    if (!(target instanceof Element)) continue;
    const overflowX = window.getComputedStyle(target).overflowX;
    if (/^(auto|scroll|overlay)$/.test(overflowX) && target.scrollWidth > target.clientWidth + 1) {
      return true;
    }
  }

  return false;
}

export function DesktopThreadSwipeNavigation(input: {
  navigate: (direction: ThreadSwipeDirection) => boolean;
}) {
  const [gesture, setGesture] = useState<ThreadSwipeGesture | null>(null);
  const navigate = useEffectEvent(input.navigate);

  useEffect(() => {
    let accumulatedDeltaX = 0;
    let didNavigate = false;
    let idleTimer: number | null = null;

    const reset = () => {
      accumulatedDeltaX = 0;
      didNavigate = false;
      idleTimer = null;
      setGesture(null);
    };

    const onWheel = (event: WheelEvent) => {
      if (
        event.defaultPrevented ||
        event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }

      const deltaX = event.deltaX;
      if (Math.abs(deltaX) <= Math.abs(event.deltaY) * 1.15) return;
      if (canScrollHorizontally(event.composedPath())) return;

      event.preventDefault();
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(reset, SWIPE_IDLE_MS);
      if (didNavigate) return;

      if (accumulatedDeltaX !== 0 && Math.sign(accumulatedDeltaX) !== Math.sign(deltaX)) {
        accumulatedDeltaX = 0;
      }
      accumulatedDeltaX += deltaX;

      const direction = accumulatedDeltaX > 0 ? "next" : "previous";
      setGesture({
        direction,
        progress: Math.min(Math.abs(accumulatedDeltaX) / SWIPE_THRESHOLD_PX, 1),
      });
      if (Math.abs(accumulatedDeltaX) < SWIPE_THRESHOLD_PX) return;

      didNavigate = true;
      navigate(direction);
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel);
      if (idleTimer !== null) window.clearTimeout(idleTimer);
    };
  }, []);

  if (gesture === null) return null;

  const isPrevious = gesture.direction === "previous";
  const edgeOffset = (1 - gesture.progress) * 45;
  const ArrowIcon = isPrevious ? ArrowLeftIcon : ArrowRightIcon;
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed inset-y-0 z-[5] overflow-hidden ${
        isPrevious
          ? "right-0 left-0 md:left-[var(--sidebar-width)] md:group-data-[collapsible=offcanvas]:left-0"
          : "inset-x-0"
      }`}
    >
      <div
        data-desktop-thread-swipe-indicator={gesture.direction}
        data-desktop-thread-swipe-progress={gesture.progress.toFixed(2)}
        className={`absolute top-1/2 flex h-24 w-12 items-center justify-center border-primary/20 text-primary-foreground shadow-lg ${
          isPrevious
            ? "left-0 origin-left rounded-r-3xl border-y border-r"
            : "right-0 origin-right rounded-l-3xl border-y border-l"
        }`}
        style={{
          backgroundColor: `color-mix(in oklab, var(--primary) ${35 + gesture.progress * 65}%, transparent)`,
          transform: `translate3d(${isPrevious ? -edgeOffset : edgeOffset}%, -50%, 0)`,
        }}
      >
        <ArrowIcon className="size-6" strokeWidth={3} />
      </div>
    </div>
  );
}

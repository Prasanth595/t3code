import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";

import { useDismissTooltips } from "../ui/tooltip";

// Long enough to bridge the frames of one wheel or momentum stream, which
// arrive every ~16ms, and short enough that the next swipe starts fresh.
const WHEEL_GESTURE_GAP_MS = 150;
const WHEEL_AXIS_LOCK_PX = 8;
const WHEEL_STEP_PX = 40;
const SCROLL_IDLE_MS = 150;

export const isProjectPagerElement = (element: Element) =>
  element.hasAttribute("data-project-pager");

/**
 * One step of a sidebar wheel gesture. A gesture locks to its dominant axis
 * once it moves a few pixels, and a horizontal one steps at most one project,
 * so a fling and its momentum cannot skip past the next project.
 */
export function stepSidebarWheel(
  gesture: { at: number; x: number; y: number; axis: "x" | "y" | null; stepped: boolean } | null,
  event: { dx: number; dy: number; at: number },
) {
  const current =
    gesture === null || event.at - gesture.at > WHEEL_GESTURE_GAP_MS
      ? { x: 0, y: 0, axis: null, stepped: false }
      : gesture;
  const x = current.x + event.dx;
  const y = current.y + event.dy;
  const axis =
    current.axis ??
    (Math.max(Math.abs(x), Math.abs(y)) < WHEEL_AXIS_LOCK_PX
      ? null
      : Math.abs(x) > Math.abs(y)
        ? "x"
        : "y");
  const step = axis === "x" && !current.stepped && Math.abs(x) >= WHEEL_STEP_PX ? Math.sign(x) : 0;
  return { gesture: { at: event.at, x, y, axis, stepped: current.stepped || step !== 0 }, step };
}

/**
 * The pages beside the displayed scope, in project order: `null` is All, and
 * `undefined` means there is no page on that side.
 */
export function projectPagerNeighbours(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  scopeKey: string | null,
) {
  const scopes = [null, ...groups];
  const index = scopes.findIndex((scope) => (scope?.projectKey ?? null) === scopeKey);
  return index === -1
    ? { previous: undefined, next: undefined }
    : { previous: scopes[index - 1], next: scopes[index + 1] };
}

// Safari before 26.2 has no scrollend. Checked per event, so the first
// gesture in an engine that has it already waits for the engine's own end.
const reportsScrollEnd = (element: HTMLElement) => "onscrollend" in element;

// Scope keys preserve each page and its scroll position when a neighbour becomes live.
// Header/footer wheel input cannot chain into the pager, so it is forwarded separately.
export function ProjectPager({
  pages,
  scopeKey,
  onScopeChange,
}: {
  pages: ReadonlyArray<{ scopeKey: string | null; content: ReactNode }>;
  scopeKey: string | null;
  /** Called with the neighbour a scroll landed on. */
  onScopeChange: (key: string | null) => void;
}) {
  const pagerRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The last position the pager reported, and the scope and page index it
  // was placed for. Removing a page before the current one clamps scrollLeft
  // before effects run, so placement starts from what was on screen.
  const placedRef = useRef<{ scopeKey: string | null; index: number; left: number } | null>(null);
  const index = pages.findIndex((page) => page.scopeKey === scopeKey);
  // A tooltip left over a page sliding away, or one waiting on its hover
  // delay, would float over the neighbour, so a swipe closes them as it starts.
  const dismissTooltips = useDismissTooltips();

  const commit = useStableCallback((key: string | null) => onScopeChange(key));
  // A delayed settle must land on the neighbours on screen when it fires, not
  // on those of the render that armed it: activity sorting can reorder them.
  const settle = useStableCallback(() => {
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = undefined;
    const pager = pagerRef.current;
    if (!pager || pager.clientWidth === 0) return;
    // Only a page the scroll rests on counts, never one it is passing.
    const landed =
      pages[
        Array.from(pager.children).findIndex(
          (page) =>
            page instanceof HTMLElement && Math.abs(page.offsetLeft - pager.scrollLeft) <= 1,
        )
      ];
    // Rendering the new scope synchronously lets the pager recentre on the
    // landed page before it paints off-centre.
    if (landed !== undefined && landed.scopeKey !== scopeKey) {
      flushSync(() => commit(landed.scopeKey));
    }
  });
  const armIdleTimer = useStableCallback(() => {
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(settle, SCROLL_IDLE_MS);
  });

  // A sidebar that was hidden or changed width must not re-snap onto a
  // neighbour, which would read as a swipe. Every scope change, and every page
  // appearing or leaving before the current one, places the pages again.
  useLayoutEffect(() => {
    const pager = pagerRef.current;
    const current = currentRef.current;
    if (!pager || !current) return;
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = undefined;
    let width = pager.clientWidth;
    const placed = placedRef.current;
    // A new scope lands on its page. Pages appearing or leaving before the same
    // scope keep the page on screen, so a swipe under way carries on.
    pager.scrollLeft =
      placed?.scopeKey === scopeKey
        ? placed.left + (index - placed.index) * width
        : current.offsetLeft;
    placedRef.current = { scopeKey, index, left: pager.scrollLeft };
    // Only a width change moves the pages; the observer's first report and
    // height changes must not undo a swipe already under way.
    return observeResize(pager, () => {
      if (pager.clientWidth === width) return;
      width = pager.clientWidth;
      pager.scrollLeft = current.offsetLeft;
    });
  }, [scopeKey, index]);

  useEffect(() => () => clearTimeout(idleTimerRef.current), []);

  useEffect(() => {
    const pager = pagerRef.current;
    const sidebar = pager?.closest('[data-sidebar="sidebar"]');
    if (!pager || !(sidebar instanceof HTMLElement)) return;
    let gesture: Parameters<typeof stepSidebarWheel>[0] = null;
    // Every sideways gesture, including one over a list or against the first
    // or last project, where the pager does not move.
    let intent: Parameters<typeof stepSidebarWheel>[0] = null;
    const onWheel = (event: WheelEvent) => {
      // At a clamped edge the position stops changing while the gesture goes
      // on, so without scrollend only input going quiet can end it.
      if (idleTimerRef.current !== undefined && !reportsScrollEnd(pager)) armIdleTimer();
      const target = event.target;
      if (!(target instanceof Element)) return;
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      // Windows reports a Shift+wheel as vertical delta and scrolls it sideways.
      const sideways = event.shiftKey && event.deltaX === 0 && !event.ctrlKey;
      const delta = {
        dx: (sideways ? event.deltaY : event.deltaX) * scale,
        dy: (sideways ? 0 : event.deltaY) * scale,
        at: event.timeStamp,
      };
      intent = stepSidebarWheel(intent, delta).gesture;
      if (intent.axis === "x") dismissTooltips();
      if (pager.contains(target) && !sideways) return;
      const result = stepSidebarWheel(gesture, delta);
      gesture = result.gesture;
      if (result.step === 0) return;
      pager.scrollBy({
        left: result.step * pager.clientWidth,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
    };
    // Shift+wheel is not converted to horizontal input by every browser. Stop
    // its vertical default inside the list; the sidebar listener pages instead.
    const onPagerWheel = (event: WheelEvent) => {
      if (event.shiftKey && event.deltaX === 0 && !event.ctrlKey) event.preventDefault();
    };
    pager.addEventListener("wheel", onPagerWheel, { passive: false });
    sidebar.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      pager.removeEventListener("wheel", onPagerWheel);
      sidebar.removeEventListener("wheel", onWheel);
    };
  }, [armIdleTimer, dismissTooltips]);

  return (
    <div
      ref={pagerRef}
      // Thread drags must not auto-scroll this pager into another project.
      data-project-pager=""
      // The list's viewport contains overscroll on both axes. Letting x chain
      // hands a sideways swipe over the threads to this pager.
      className="relative flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&_[data-slot=scroll-area-viewport]]:overscroll-x-auto"
      onScroll={(event) => {
        const pager = event.currentTarget;
        // Settling only once the gesture ends keeps one fling to one project.
        if (!reportsScrollEnd(pager)) armIdleTimer();
        // Placing the pages reports its own position; anything else moved them.
        if (pager.scrollLeft !== placedRef.current?.left) dismissTooltips();
        if (placedRef.current) placedRef.current.left = pager.scrollLeft;
      }}
      onScrollEnd={settle}
    >
      {pages.map((page) => {
        const current = page.scopeKey === scopeKey;
        return (
          <div
            key={page.scopeKey ?? ""}
            ref={current ? currentRef : undefined}
            inert={!current}
            data-project-page={page.scopeKey ?? ""}
            className="flex min-h-0 w-full shrink-0 snap-center snap-always flex-col"
          >
            {page.content}
          </div>
        );
      })}
    </div>
  );
}

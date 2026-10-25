import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { LayersIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { flushSync } from "react-dom";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PILL_POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };
const PILL_DND_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
// Long enough to bridge the frames of one wheel or momentum stream, which
// arrive every ~16ms, and short enough that the next swipe starts fresh.
const WHEEL_GESTURE_GAP_MS = 150;
const WHEEL_AXIS_LOCK_PX = 8;
const WHEEL_STEP_PX = 40;
const SCROLL_IDLE_MS = 150;

const pillClassName =
  "relative inline-flex h-6 max-w-40 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2 text-xs font-medium outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function pillStateClassName(active: boolean) {
  return active
    ? "text-sidebar-foreground"
    : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground";
}

export const isProjectPagerElement = (element: Element) =>
  element.hasAttribute("data-project-pager");

const selectionScroll = () =>
  window.matchMedia(REDUCED_MOTION_QUERY).matches ? "instant" : "smooth";

// scrollIntoView would also scroll the sidebar's clipped ancestors, so only
// the bar moves.
function revealPill(bar: HTMLElement, pill: HTMLElement) {
  const start = pill.offsetLeft;
  const end = start + pill.offsetWidth;
  if (start < bar.scrollLeft) bar.scrollLeft = start;
  else if (end > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = end - bar.clientWidth;
}

/**
 * One pill per project after a fixed "All" pill. `null` is the all-projects
 * scope, matching the sidebar's persisted scope key.
 *
 * The current pill sits at the bar's left edge under one highlight. While the
 * sidebar pager swipes, `trackSwipe` scrolls the pills beneath the highlight
 * and resizes it towards the incoming pill, so the highlight itself stays put.
 */
export function ProjectSwitcherBar({
  ref,
  groups,
  scopeKey,
  targetKey,
  onScopeChange,
  onReorder,
  onOpenProjectSettings,
  renderBadge,
}: {
  ref?: Ref<{ trackSwipe: (progress: number) => void }>;
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  scopeKey: string | null;
  /** A picked pill the sidebar is still scrolling to; the highlight moves there first. */
  targetKey?: string | null | undefined;
  onScopeChange: (key: string | null) => void;
  onReorder: (active: SidebarProjectSnapshot, over: SidebarProjectSnapshot) => void;
  onOpenProjectSettings: (group: SidebarProjectSnapshot) => void;
  renderBadge: (group: SidebarProjectSnapshot) => ReactNode;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLSpanElement>(null);
  const spacerRef = useRef<HTMLSpanElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, PILL_POINTER_SENSOR_OPTIONS));
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const moveHintId = useId();
  const [moveAnnouncement, setMoveAnnouncement] = useState("");

  // `progress` is the pager's offset from the current page, in pages: -1 is
  // the previous project, 1 the next. The highlight lives in the scrolled
  // content, so moving it and the bar by the same amount keeps it in place on
  // screen. `scroll` null places the highlight without moving the bar, and only
  // an instant placement skips the highlight's own transition.
  const place = useStableCallback((progress: number, scroll: ScrollBehavior | null) => {
    const bar = barRef.current;
    const highlight = highlightRef.current;
    const spacer = spacerRef.current;
    if (!bar || !highlight || !spacer) return;
    const pills = Array.from(bar.querySelectorAll<HTMLElement>("[data-scope-key]"));
    const fromKey = targetKey === undefined ? scopeKey : targetKey;
    const from = pills.find((pill) => pill.dataset.scopeKey === (fromKey ?? ""));
    const last = pills.at(-1);
    if (!from || !last) return;
    const to = pills[pills.indexOf(from) + Math.sign(progress)] ?? from;
    const t = Math.min(1, Math.abs(progress));
    const left = from.offsetLeft + (to.offsetLeft - from.offsetLeft) * t;
    highlight.style.transition = scroll === "instant" ? "none" : "";
    highlight.style.transform = `translateX(${left}px)`;
    highlight.style.width = `${from.offsetWidth + (to.offsetWidth - from.offsetWidth) * t}px`;
    // Room after the last pill to bring it to the left edge too.
    const gap = spacer.offsetLeft - last.offsetLeft - last.offsetWidth;
    spacer.style.width = `${Math.max(0, bar.clientWidth - last.offsetWidth - gap)}px`;
    if (scroll !== null) bar.scrollTo({ left, behavior: scroll });
  });
  useImperativeHandle(ref, () => ({
    // Settling, or snapping back, eases the bar home like a selection would.
    trackSwipe: (progress) => place(progress, progress === 0 ? selectionScroll() : "instant"),
  }));

  // A picked pill first draws the highlight across to it; the bar brings it to
  // the left edge once the sidebar has scrolled there and selected it.
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    if (targetKey !== undefined) place(0, null);
    else place(0, mountedRef.current ? selectionScroll() : "instant");
    mountedRef.current = true;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `place` reads the latest scope; a new scope or target is what moves the highlight.
  }, [place, scopeKey, targetKey]);
  // A reorder or a project joining moves the current pill; the highlight
  // follows it without scrolling away from a pill the user is moving.
  const orderKey = groups.map((group) => group.projectKey).join("\n");
  useLayoutEffect(() => {
    place(0, null);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new pill order is what moves the current pill.
  }, [place, orderKey]);
  // Any wheel over the row moves the row. A sideways one scrolls it natively,
  // momentum and all; one that is mostly vertical, a mouse wheel or Shift+wheel
  // on Windows included, moves it sideways instead of reaching the sidebar.
  // Ctrl+wheel is pinch-zoom and passes through.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      bar.scrollBy({ left: event.deltaY * scale, behavior: "instant" });
    };
    bar.addEventListener("wheel", onWheel, { passive: false });
    return () => bar.removeEventListener("wheel", onWheel);
  }, []);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    let width = bar.clientWidth;
    return observeResize(bar, () => {
      if (bar.clientWidth === width) return;
      width = bar.clientWidth;
      place(0, "instant");
    });
  }, [place]);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const activeGroup = groups.find((group) => group.projectKey === active.id);
    const overGroup = groups.find((group) => group.projectKey === over.id);
    if (activeGroup && overGroup) onReorder(activeGroup, overGroup);
  };

  // dnd-kit's default announcements read out the raw project key, a local
  // path. Name the project and its place among the project pills instead, as
  // the Alt+arrow moves do; All is fixed and never dragged.
  const pillName = (id: UniqueIdentifier) =>
    groups.find((group) => group.projectKey === id)?.displayName ?? "Project";
  const pillPosition = (id: UniqueIdentifier) =>
    `position ${groups.findIndex((group) => group.projectKey === id) + 1} of ${groups.length}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${pillName(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over === null
        ? `${pillName(active.id)} is not over a project.`
        : over.id === active.id
          ? `${pillName(active.id)} is at ${pillPosition(active.id)}.`
          : `${pillName(active.id)} is over ${pillPosition(over.id)}.`,
    onDragEnd: ({ active, over }) =>
      over === null || over.id === active.id
        ? `${pillName(active.id)} stays at ${pillPosition(active.id)}.`
        : `Moved ${pillName(active.id)} to ${pillPosition(over.id)}.`,
    onDragCancel: ({ active }) =>
      `Stopped moving ${pillName(active.id)}. It stays at ${pillPosition(active.id)}.`,
  };

  const movePill = (pill: HTMLElement, group: SidebarProjectSnapshot, offset: number) => {
    const index = groups.indexOf(group) + offset;
    const neighbour = groups[index];
    if (!neighbour) return;
    flushSync(() => {
      onReorder(group, neighbour);
      setMoveAnnouncement(
        `Moved ${group.displayName} to position ${index + 1} of ${groups.length}`,
      );
    });
    // React moves a keyed node with insertBefore, which the DOM spec says
    // blurs it. Chromium happens to keep focus; other engines need this.
    pill.focus({ preventScroll: true });
    if (barRef.current) revealPill(barRef.current, pill);
  };

  return (
    <div
      ref={barRef}
      role="group"
      aria-label="Switch project"
      data-project-switcher-bar=""
      className="relative flex gap-1 overflow-x-auto overscroll-x-contain pt-1 [scrollbar-width:none]"
    >
      <span
        ref={highlightRef}
        aria-hidden
        data-pill-highlight=""
        className="pointer-events-none absolute top-1 left-0 h-6 rounded-full bg-sidebar-row-active shadow-xs motion-safe:transition-[transform,width] motion-safe:duration-200 motion-safe:ease-out"
      />
      <button
        type="button"
        aria-pressed={scopeKey === null}
        data-scope-key=""
        className={cn(pillClassName, pillStateClassName(scopeKey === null))}
        onClick={() => onScopeChange(null)}
      >
        <LayersIcon className="size-3.5 shrink-0" />
        All
      </button>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={PILL_DND_MODIFIERS}
        accessibility={{ announcements }}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={groups.map((group) => group.projectKey)}
          strategy={horizontalListSortingStrategy}
        >
          {groups.map((group) => (
            <ProjectPill
              key={group.projectKey}
              group={group}
              active={group.projectKey === scopeKey}
              badge={renderBadge(group)}
              reducedMotion={reducedMotion}
              moveHintId={moveHintId}
              onSelect={() => onScopeChange(group.projectKey)}
              onMove={(pill, offset) => movePill(pill, group, offset)}
              onOpenSettings={() => onOpenProjectSettings(group)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <span ref={spacerRef} aria-hidden className="shrink-0" />
      <span id={moveHintId} hidden>
        Press Alt+Left Arrow or Alt+Right Arrow to move this project.
      </span>
      <span role="status" className="sr-only">
        {moveAnnouncement}
      </span>
    </div>
  );
}

function ProjectPill({
  group,
  active,
  badge,
  reducedMotion,
  moveHintId,
  onSelect,
  onMove,
  onOpenSettings,
}: {
  group: SidebarProjectSnapshot;
  active: boolean;
  badge: ReactNode;
  reducedMotion: boolean;
  moveHintId: string;
  onSelect: () => void;
  onMove: (pill: HTMLElement, offset: number) => void;
  onOpenSettings: () => void;
}) {
  // Alt+arrow keys reorder instead of dnd-kit's keyboard sensor, whose
  // Enter/Space pickup would collide with selecting the pill.
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.projectKey,
    ...(reducedMotion ? { transition: null } : {}),
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      aria-pressed={active}
      aria-describedby={moveHintId}
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
      data-scope-key={group.projectKey}
      className={cn(pillClassName, pillStateClassName(active), isDragging && "z-10 shadow-md")}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      {...listeners}
      onClick={(event) => {
        // macOS Ctrl+click is a secondary click, and Safari follows its
        // contextmenu with a click.
        if (!event.ctrlKey) onSelect();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenSettings();
      }}
      onKeyDown={(event) => {
        const offset = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
        if (offset === 0 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
          return;
        }
        event.preventDefault();
        onMove(event.currentTarget, offset);
      }}
    >
      <ProjectFavicon project={group} className="size-3.5 shrink-0" />
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 truncate" />}>
          {group.displayName}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{group.displayName}</TooltipPopup>
      </Tooltip>
      {badge}
    </button>
  );
}

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
 * The pages beside the displayed scope, in pill order: `null` is All, and
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

/**
 * The pages a picked pill scrolls through: every scope from the displayed one
 * to each pill picked while the scroll runs, in pill order, so a later pick
 * only changes where the scroll is headed. `undefined` when there is nothing
 * to scroll through: the latest pick is the displayed scope with nothing else
 * on the way, or no longer exists.
 */
function projectPagerRoute(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  scopeKey: string | null,
  picks: ReadonlyArray<string | null>,
) {
  const scopes = [null, ...groups];
  const indexOf = (key: string | null) =>
    scopes.findIndex((scope) => (scope?.projectKey ?? null) === key);
  const ends = [scopeKey, ...picks].map(indexOf).filter((index) => index !== -1);
  const from = Math.min(...ends);
  const to = Math.max(...ends);
  if (indexOf(scopeKey) === -1 || indexOf(picks.at(-1) ?? null) === -1 || from === to) {
    return undefined;
  }
  return scopes.slice(from, to + 1);
}

const NO_NEIGHBOURS = { previous: undefined, next: undefined };
const NO_PICKS: ReadonlyArray<string | null> = [];

/**
 * Which scopes the pager shows: the displayed scope and its neighbours, or,
 * after `pick`, every scope on the way to the picked one. `land` takes the page
 * a scroll rested on; only that selects a scope. Under reduced motion a pick
 * selects at once.
 */
export function useProjectPagerRoute({
  groups,
  scopeKey,
  enabled,
  onScopeChange,
}: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  scopeKey: string | null;
  enabled: boolean;
  onScopeChange: (key: string | null) => void;
}) {
  const [picks, setPicks] = useState(NO_PICKS);
  const route =
    enabled && picks.length > 0 ? projectPagerRoute(groups, scopeKey, picks) : undefined;
  // Reached, removed, or the switcher turned off.
  if (picks.length > 0 && route === undefined) setPicks(NO_PICKS);
  const neighbours = enabled ? projectPagerNeighbours(groups, scopeKey) : NO_NEIGHBOURS;
  const current = groups.find((group) => group.projectKey === scopeKey) ?? null;
  return {
    neighbours,
    targetKey: route === undefined ? undefined : picks.at(-1),
    scopes: !enabled
      ? []
      : (route ??
        [neighbours.previous, current, neighbours.next].filter((scope) => scope !== undefined)),
    pick: (key: string | null) => {
      if (window.matchMedia(REDUCED_MOTION_QUERY).matches) {
        setPicks(NO_PICKS);
        onScopeChange(key);
      } else {
        setPicks((previous) => [...previous, key]);
      }
    },
    land: (key: string | null) => {
      setPicks(NO_PICKS);
      if (key !== scopeKey) onScopeChange(key);
    },
  };
}

// Safari before 26.2 has no scrollend. Checked per event, so the first
// gesture in an engine that has it already waits for the engine's own end.
const reportsScrollEnd = (element: HTMLElement) => "onscrollend" in element;

/**
 * Horizontal scroll-snap pager over the displayed scope and its neighbours.
 * Each page is keyed by its scope, so the neighbour a swipe lands on is the
 * same rendered page that becomes current, scroll position and all; the pager
 * then re-centres on it. Pages other than the current one are inert.
 *
 * With a `targetKey`, the pages run from the displayed scope to the target and
 * the pager scrolls natively through all of them; the target is selected only
 * once the scroll lands on it.
 *
 * A sideways swipe over a list chains natively into this pager. Elsewhere in
 * the sidebar, outside the pill bar, a passive wheel listener pages it one
 * project per gesture, since a sibling cannot chain into it.
 */
export function ProjectSwitcherPager({
  pages,
  scopeKey,
  targetKey,
  onScopeChange,
  onSwipe,
}: {
  pages: ReadonlyArray<{ scopeKey: string | null; content: ReactNode }>;
  scopeKey: string | null;
  targetKey?: string | null | undefined;
  /**
   * Called with the page a scroll landed on: a new scope, or the displayed one
   * when a scroll towards `targetKey` ended back there.
   */
  onScopeChange: (key: string | null) => void;
  /** The offset from the current page, in pages, on every scroll. */
  onSwipe?: (progress: number) => void;
}) {
  const pagerRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Whether the pager has moved, or had wheel input, since the latest pick
  // started its scroll. Placing pages for a pick produces its own scrollend,
  // which must not read as landing.
  const departedRef = useRef(false);
  const routeStartRef = useRef(0);
  // The last position the pager reported, and the scope and page index it
  // was placed for. Removing a page before the current one clamps scrollLeft
  // before effects run, so placement starts from what was on screen.
  const placedRef = useRef<{ scopeKey: string | null; index: number; left: number } | null>(null);
  const index = pages.findIndex((page) => page.scopeKey === scopeKey);
  const targetIndex =
    targetKey === undefined ? -1 : pages.findIndex((page) => page.scopeKey === targetKey);

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
    if (landed === undefined) return;
    // While a pick scrolls, wherever it comes to rest counts, the current page
    // included, once it has really moved. Rendering the new scope synchronously
    // lets the pager recentre on the landed page before it paints off-centre.
    if (targetKey === undefined ? landed.scopeKey !== scopeKey : departedRef.current) {
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
    // scope keep the page on screen; a pick ending without landing is the
    // route effect's to put right.
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

  // Each pick is its own scroll. It starts after the placement above, which
  // stops any scroll under way, so it also restarts whenever pages before the
  // current one change.
  useLayoutEffect(() => {
    departedRef.current = false;
    const pager = pagerRef.current;
    const current = currentRef.current;
    if (targetKey === undefined) {
      // A pick that ended without landing, its pill gone or the switcher off,
      // may have left a scroll under way, or a placement that kept the page on
      // screen. That page may be a neighbour, which settling would select, so
      // the current page goes back on screen.
      if (pager && current && Math.abs(pager.scrollLeft - current.offsetLeft) > 1) {
        pager.scrollLeft = current.offsetLeft;
        placedRef.current = { scopeKey, index, left: pager.scrollLeft };
      }
      return;
    }
    const target = pager?.children[targetIndex];
    if (!pager || !(target instanceof HTMLElement)) return;
    routeStartRef.current = pager.scrollLeft;
    // Already there, as when a pick is taken back before the scroll moves: no
    // scroll would run, so no scrollend would ever land it.
    if (Math.abs(pager.scrollLeft - target.offsetLeft) <= 1) {
      commit(targetKey);
      return;
    }
    // Chromium keeps the destination of a smooth scroll the placement above
    // interrupted, and ignores a new one to the same offset, as when a pick
    // further back puts its target at the start, where the last one was.
    // Aiming at some other page first, superseded before any frame, clears it.
    const other = Array.from(pager.children).find(
      (page) =>
        page instanceof HTMLElement &&
        page !== target &&
        Math.abs(page.offsetLeft - pager.scrollLeft) > 1,
    );
    if (other instanceof HTMLElement)
      pager.scrollTo({ left: other.offsetLeft, behavior: "smooth" });
    pager.scrollTo({ left: target.offsetLeft, behavior: "smooth" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A placement for a new page index stops the scroll under way, so the pick scrolls again.
  }, [commit, targetKey, targetIndex, index]);

  useEffect(() => () => clearTimeout(idleTimerRef.current), []);

  useEffect(() => {
    const pager = pagerRef.current;
    const sidebar = pager?.closest('[data-sidebar="sidebar"]');
    if (!pager || !(sidebar instanceof HTMLElement)) return;
    let gesture: Parameters<typeof stepSidebarWheel>[0] = null;
    const onWheel = (event: WheelEvent) => {
      departedRef.current = true;
      // At a clamped edge the position stops changing while the gesture goes
      // on, so without scrollend only input going quiet can end it.
      if (idleTimerRef.current !== undefined && !reportsScrollEnd(pager)) armIdleTimer();
      const target = event.target;
      if (
        !(target instanceof Element) ||
        pager.contains(target) ||
        target.closest("[data-project-switcher-bar]")
      ) {
        return;
      }
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      // Windows reports a Shift+wheel as vertical delta and scrolls it sideways.
      const sideways = event.shiftKey && event.deltaX === 0;
      const result = stepSidebarWheel(gesture, {
        dx: (sideways ? event.deltaY : event.deltaX) * scale,
        dy: (sideways ? 0 : event.deltaY) * scale,
        at: event.timeStamp,
      });
      gesture = result.gesture;
      if (result.step === 0) return;
      pager.scrollBy({
        left: result.step * pager.clientWidth,
        behavior: window.matchMedia(REDUCED_MOTION_QUERY).matches ? "instant" : "smooth",
      });
    };
    sidebar.addEventListener("wheel", onWheel, { passive: true });
    return () => sidebar.removeEventListener("wheel", onWheel);
  }, [armIdleTimer]);

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
        if (placedRef.current) placedRef.current.left = pager.scrollLeft;
        if (Math.abs(pager.scrollLeft - routeStartRef.current) > 1) departedRef.current = true;
        const current = currentRef.current;
        // A scroll towards a picked pill is the bar's own animation.
        if (onSwipe && targetKey === undefined && current && pager.clientWidth > 0) {
          onSwipe((pager.scrollLeft - current.offsetLeft) / pager.clientWidth);
        }
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

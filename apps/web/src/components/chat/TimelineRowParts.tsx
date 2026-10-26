import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  type TransitionEvent,
} from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { THREAD_FIND_TEXT_ATTRIBUTE } from "./threadFindHighlights";

export const MESSAGE_HEADING_LEVEL = 3;

/** Marks a reveal or collapse copy that is still resizing its row. */
export const DISCLOSURE_MOTION_ATTRIBUTE = "data-disclosure-motion";
const disclosureMotionProps = { [DISCLOSURE_MOTION_ATTRIBUTE]: "" };

/**
 * Starts a mount transition on the next frame instead of at mount. Rows a
 * disclosure inserts commit in one heavy render; a transition that starts with
 * it spends most of its time before the first paint and appears to pop in.
 */
function useStartOnNextFrame(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  // oxlint-disable-next-line t3code/react-effect-budget -- Start after the mounted DOM has painted and cancel frames on unmount.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        element.dataset.started = String(performance.now());
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [ref, enabled]);
}

/**
 * Only user toggles reveal; virtualized remounts must not replay it. Measured height
 * avoids grid-track gaps in Chrome and works without interpolate-size in other browsers.
 */
export function TimelineReveal({ animate, children }: { animate: boolean; children: ReactNode }) {
  const [revealing, setRevealing] = useState(
    () => animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const revealRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useStartOnNextFrame(revealRef, revealing);
  // oxlint-disable-next-line t3code/react-effect-budget -- Observe the mounted content while its reveal tracks changing DOM height.
  useLayoutEffect(() => {
    const reveal = revealRef.current;
    const content = contentRef.current;
    if (!revealing || !reveal || !content) return;
    const fitContent = () =>
      reveal.style.setProperty("--reveal-height", `${content.getBoundingClientRect().height}px`);
    fitContent();
    return observeResize(content, fitContent);
  }, [revealing]);
  if (!animate) return children;
  // A content resize mid-reveal retargets the height transition, which cancels
  // the old one. Finish once nothing is left running, or once a full transition
  // has run: streamed content would otherwise keep retargeting it indefinitely.
  const finish = (event: TransitionEvent<HTMLDivElement>) => {
    const reveal = event.currentTarget;
    if (event.target !== reveal) return;
    const elapsed = event.timeStamp - Number(reveal.dataset.started);
    const duration = parseFloat(getComputedStyle(reveal).transitionDuration) * 1000;
    if (reveal.getAnimations().length === 0 || elapsed >= duration) setRevealing(false);
  };
  return (
    <div
      ref={revealRef}
      {...(revealing ? disclosureMotionProps : {})}
      className={cn(
        revealing &&
          "h-0 overflow-hidden opacity-0 transition-[height,opacity] duration-200 ease-out data-started:h-(--reveal-height) data-started:opacity-100",
      )}
      onTransitionEnd={finish}
      onTransitionCancel={finish}
    >
      {/* Contains child margins so the measured height is the height to reveal. */}
      <div ref={contentRef} className="flow-root">
        {children}
      </div>
    </div>
  );
}

export interface CollapseGhost {
  id: number;
  node: HTMLElement;
  height: number;
  scrollOffsets: ReadonlyArray<{ element: Element; top: number; left: number }>;
}

// Attributes that identify live content. Thread find and scroll restoration
// look rows and text up by them, so the copy must not answer to them.
const LIVE_IDENTITY_ATTRIBUTES = [
  "id",
  "data-timeline-row-id",
  "data-timeline-row-kind",
  "data-message-id",
  "data-message-role",
  THREAD_FIND_TEXT_ATTRIBUTE,
];

// Copies of these would load a fresh document or show a blank surface instead
// of what was on screen, so the copy holds an empty box of the same size.
const LIVE_SURFACE_SELECTOR = "iframe, canvas, video, object, embed";

let nextCollapseGhostId = 0;

/**
 * Copies what is on screen so a collapse can shrink a picture of the content
 * after the real content unmounts. React, the virtualized list and its scroll
 * maintenance all see the collapsed layout at once; only the copy animates.
 */
export function captureCollapseGhost(element: Element | null): CollapseGhost | null {
  if (!(element instanceof HTMLElement) || element.offsetHeight === 0) return null;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const node = element.cloneNode(true) as HTMLElement;
  const originals = element.querySelectorAll("*");
  const copies = node.querySelectorAll("*");
  const scrollOffsets: Array<CollapseGhost["scrollOffsets"][number]> = [];
  originals.forEach((original, index) => {
    const copy = copies[index];
    if (copy && (original.scrollTop !== 0 || original.scrollLeft !== 0)) {
      scrollOffsets.push({ element: copy, top: original.scrollTop, left: original.scrollLeft });
    }
  });
  for (const copy of [node, ...copies]) {
    for (const attribute of LIVE_IDENTITY_ATTRIBUTES) copy.removeAttribute(attribute);
  }
  originals.forEach((original, index) => {
    const copy = copies[index];
    if (!copy?.matches(LIVE_SURFACE_SELECTOR) || !node.contains(copy)) return;
    const { width, height } = original.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.style.cssText = `width:${width}px;height:${height}px`;
    copy.replaceWith(placeholder);
  });
  // Collapsing mid-reveal starts from what is showing, not the clipped full height.
  const reveal = element.closest(`[${DISCLOSURE_MOTION_ATTRIBUTE}]`);
  const height = reveal
    ? Math.min(element.offsetHeight, reveal.getBoundingClientRect().height)
    : element.offsetHeight;
  nextCollapseGhostId += 1;
  return { id: nextCollapseGhostId, node, height, scrollOffsets };
}

/** Stacks copies of consecutive rows into one, showing at most `maxHeight` of them. */
export function stackCollapseGhosts(
  ghosts: ReadonlyArray<CollapseGhost>,
  maxHeight: number,
): CollapseGhost | null {
  if (ghosts.length === 0 || maxHeight <= 0) return null;
  const node = document.createElement("div");
  node.append(...ghosts.map((ghost) => ghost.node));
  const height = ghosts.reduce((total, ghost) => total + ghost.height, 0);
  nextCollapseGhostId += 1;
  return {
    id: nextCollapseGhostId,
    node,
    height: Math.min(height, maxHeight),
    scrollOffsets: ghosts.flatMap((ghost) => ghost.scrollOffsets),
  };
}

function attachCollapseGhost(host: HTMLElement, ghost: CollapseGhost) {
  host.replaceChildren(ghost.node);
  // Cloning resets scroll offsets; without this the copy jumps to the top.
  for (const { element, top, left } of ghost.scrollOffsets) {
    element.scrollTop = top;
    element.scrollLeft = left;
  }
}

/** Shrinks and fades a captured copy away; the mirror of `TimelineReveal`. */
export function CollapseGhostView({ ghost, onDone }: { ghost: CollapseGhost; onDone: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const shrinkRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- Attach the captured DOM and restore scroll offsets before paint.
  useLayoutEffect(() => {
    if (hostRef.current) attachCollapseGhost(hostRef.current, ghost);
  }, [ghost]);
  useStartOnNextFrame(shrinkRef, true);
  const finish = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.propertyName === "height") onDone();
  };
  return (
    <div
      ref={shrinkRef}
      aria-hidden
      inert
      // Our LegendList patch applies shrinks under this marker immediately
      // rather than a frame late, so rows below follow the copy every frame.
      data-list-animated-shrink=""
      {...disclosureMotionProps}
      className="pointer-events-none h-(--ghost-height) overflow-hidden transition-[height,opacity] duration-200 ease-out [overflow-anchor:none] data-started:h-0 data-started:opacity-0"
      style={{ "--ghost-height": `${ghost.height}px` } as CSSProperties}
      onTransitionEnd={finish}
      onTransitionCancel={finish}
    >
      <div ref={hostRef} />
    </div>
  );
}

export function MessageAuthorHeading({ children }: { children: string }) {
  return <h3 className="sr-only select-none">{children}</h3>;
}

export function TimelineRowTimestamp({
  createdAt,
  timestampFormat,
  className,
  alwaysVisible = false,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
  className?: string;
  alwaysVisible?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
              alwaysVisible && "pointer-events-auto static opacity-100",
              className,
            )}
          />
        }
      >
        {formatDayAwareTimestamp(createdAt, timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(createdAt, timestampFormat)}</TooltipPopup>
    </Tooltip>
  );
}

export function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}

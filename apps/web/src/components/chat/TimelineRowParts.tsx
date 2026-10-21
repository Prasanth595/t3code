import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type TransitionEvent,
} from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { THREAD_FIND_TEXT_ATTRIBUTE } from "./threadFindHighlights";

export const MESSAGE_HEADING_LEVEL = 3;

/**
 * Grows content in from zero height as it mounts. Pass `animate` only for a
 * mount the user just caused: virtualized rows remount while scrolling, and a
 * restored expansion must not replay the reveal. Clipping lasts only as long
 * as the transition so popovers and focus rings are not cut off afterwards.
 */
export function TimelineReveal({ animate, children }: { animate: boolean; children: ReactNode }) {
  const [clipping, setClipping] = useState(animate);
  if (!animate) return children;
  const stopClipping = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) setClipping(false);
  };
  return (
    <div
      className="grid grid-rows-[1fr] transition-[grid-template-rows,opacity] duration-200 ease-out starting:grid-rows-[0fr] starting:opacity-0 motion-reduce:transition-none"
      onTransitionEnd={stopClipping}
      onTransitionCancel={stopClipping}
    >
      <div className={cn("min-h-0", clipping && "overflow-hidden motion-reduce:overflow-visible")}>
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
  nextCollapseGhostId += 1;
  return { id: nextCollapseGhostId, node, height: element.offsetHeight, scrollOffsets };
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
  useLayoutEffect(() => {
    if (hostRef.current) attachCollapseGhost(hostRef.current, ghost);
  }, [ghost]);
  const finish = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.propertyName === "height") onDone();
  };
  return (
    <div
      aria-hidden
      inert
      className="pointer-events-none h-0 overflow-hidden opacity-0 transition-[height,opacity] duration-200 ease-out [overflow-anchor:none] starting:h-(--ghost-height) starting:opacity-100"
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

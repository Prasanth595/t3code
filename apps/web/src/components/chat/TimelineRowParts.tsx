import { useState, type ReactNode, type TransitionEvent } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";

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

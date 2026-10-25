import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";

// Base UI's default, restated because a padding object zeroes the sides it omits.
const COLLISION_PADDING = 5;

const TooltipProvider = TooltipPrimitive.Provider;

type TooltipActionsRef = RefObject<TooltipPrimitive.Root.Actions | null>;

// Context values are frozen to the compiler, so consumers update the hovered
// and open tooltips through these calls rather than by writing to a shared ref.
function createTooltipTracker() {
  let hovered: { trigger: HTMLElement; actionsRef: TooltipActionsRef } | null = null;
  // Hover only reaches tooltips opened by the mouse; a focused one is tracked once open.
  const open = new Set<TooltipActionsRef>();
  return {
    hover(trigger: HTMLElement, actionsRef: TooltipActionsRef) {
      hovered = { trigger, actionsRef };
    },
    opened(actionsRef: TooltipActionsRef) {
      open.add(actionsRef);
    },
    release(actionsRef: TooltipActionsRef) {
      if (hovered?.actionsRef === actionsRef) hovered = null;
      open.delete(actionsRef);
    },
    dismissUnfocused() {
      const tooltip = hovered;
      if (!tooltip || tooltip.trigger.contains(tooltip.trigger.ownerDocument.activeElement)) {
        return;
      }
      hovered = null;
      // Base UI also cancels delayed hover opens through this action.
      tooltip.actionsRef.current?.close();
    },
    dismissAll() {
      const tooltips = new Set(open);
      if (hovered) tooltips.add(hovered.actionsRef);
      hovered = null;
      open.clear();
      // Closing blocks the hover open until the pointer re-enters the trigger,
      // so a cursor held still over it does not bring the tooltip back.
      for (const actionsRef of tooltips) actionsRef.current?.close();
    },
  };
}

type TooltipTracker = ReturnType<typeof createTooltipTracker>;
const TooltipHoverContext = createContext<TooltipActionsRef | null>(null);
const TooltipTrackerContext = createContext<TooltipTracker | null>(null);

function TooltipScrollDismissArea({ onScrollCapture, ...props }: ComponentProps<"div">) {
  const [tracker] = useState(createTooltipTracker);
  return (
    <TooltipTrackerContext value={tracker}>
      <div
        {...props}
        onScrollCapture={(event) => {
          onScrollCapture?.(event);
          tracker.dismissUnfocused();
        }}
      />
    </TooltipTrackerContext>
  );
}

/**
 * Tooltips inside, portalled popups included, can be closed together with
 * `useDismissTooltips`, whether hovered, focused or waiting on their delay.
 */
function TooltipDismissScope({ children }: { children: ReactNode }) {
  const [tracker] = useState(createTooltipTracker);
  return <TooltipTrackerContext value={tracker}>{children}</TooltipTrackerContext>;
}

const noop = () => {};

function useDismissTooltips() {
  return use(TooltipTrackerContext)?.dismissAll ?? noop;
}

function Tooltip<Payload>(props: TooltipPrimitive.Root.Props<Payload>) {
  const tracker = use(TooltipTrackerContext);
  const localActionsRef = useRef<TooltipPrimitive.Root.Actions | null>(null);
  const actionsRef = props.actionsRef ?? localActionsRef;
  useEffect(() => () => tracker?.release(actionsRef), [actionsRef, tracker]);

  if (!tracker) return <TooltipPrimitive.Root {...props} />;
  return (
    <TooltipHoverContext value={actionsRef}>
      <TooltipPrimitive.Root
        {...props}
        actionsRef={actionsRef}
        onOpenChange={(open, details) => {
          props.onOpenChange?.(open, details);
          if (details.isCanceled) return;
          if (open) tracker.opened(actionsRef);
          else tracker.release(actionsRef);
        }}
      />
    </TooltipHoverContext>
  );
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  const tracker = use(TooltipTrackerContext);
  const actionsRef = use(TooltipHoverContext);
  if (!tracker || !actionsRef) {
    return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
  }
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onMouseEnter={(event) => {
        props.onMouseEnter?.(event);
        tracker.hover(event.currentTarget, actionsRef);
      }}
    />
  );
}

function TooltipPositioner(props: TooltipPrimitive.Positioner.Props) {
  const titlebarHeight = useNativeTitlebarHeight();
  return (
    <TooltipPrimitive.Positioner
      className="pointer-events-none z-[140] h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"
      collisionPadding={{
        top: COLLISION_PADDING + titlebarHeight,
        right: COLLISION_PADDING,
        bottom: COLLISION_PADDING,
        left: COLLISION_PADDING,
      }}
      data-slot="tooltip-positioner"
      {...props}
    />
  );
}

function TooltipPopup({
  className,
  align = "center",
  sideOffset = 4,
  side = "top",
  variant = "default",
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  variant?: "default" | "glass" | "code";
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPositioner align={align} anchor={anchor} side={side} sideOffset={sideOffset}>
        <TooltipPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md text-popover-foreground text-xs transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            variant === "glass"
              ? "dropdown-glass shadow-xl shadow-black/25 before:hidden"
              : "border bg-popover not-dark:bg-clip-padding shadow-md/5",
            variant === "code"
              ? "max-w-120 wrap-anywhere text-left font-mono text-[11px] leading-relaxed"
              : "max-w-80 wrap-anywhere whitespace-normal leading-snug",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Viewport
            className="relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity"
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPositioner>
    </TooltipPrimitive.Portal>
  );
}

export {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  TooltipScrollDismissArea,
  TooltipDismissScope,
  useDismissTooltips,
};

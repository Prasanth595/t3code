import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";

import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { selectUsagePanelOpen, useUsagePanelStore } from "../../usagePanelStore";
import { Popover, PopoverCreateHandle, PopoverPopup } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { useChatCanvas } from "./ChatCanvasContext";
import { THREAD_DETAILS_CARD_GAP } from "./threadDetailsCardLayout";

/**
 * Provider usage for the open thread. It stacks under the thread details card in the same
 * column, and moves into a popover from its header toggle where the column has no room.
 */
export function ThreadUsageCard({
  anchor,
  handle,
  children,
}: {
  anchor: RefObject<Element | null>;
  handle: ReturnType<typeof PopoverCreateHandle>;
  children: ReactNode;
}) {
  const canvas = useChatCanvas();
  const placement = canvas?.usageCardPlacement ?? null;
  const mode = placement ? "inline" : "popover";
  const topInset = canvas?.detailsCardTopInset ?? 0;
  const inlineOpen = useUsagePanelStore((state) => selectUsagePanelOpen(state, "inline"));
  const popoverOpen = useUsagePanelStore((state) => selectUsagePanelOpen(state, "popover"));
  const measureUsageCard = canvas?.measureUsageCard;
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  // The popover flag is separate from the inline one, so a card that returned inline must not
  // reopen as a popover unasked when the column fills up again.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the popover flag in the usage panel store when the derived mode turns inline
  useLayoutEffect(() => {
    if (mode === "inline" && popoverOpen) useUsagePanelStore.getState().setOpen("popover", false);
  }, [mode, popoverOpen]);
  // Only the laid-out DOM knows the card height, and the canvas keeps a preview clear of it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the card's DOM height via ResizeObserver and reports it to the canvas
  useLayoutEffect(() => {
    const element = contentElement;
    if (!element || mode !== "inline") return;
    const measure = () => {
      const frame = element.closest<HTMLElement>("[data-thread-usage-card]");
      measureUsageCard?.(
        element.offsetHeight + (frame ? frame.offsetHeight - frame.clientHeight : 0),
      );
    };
    measure();
    return observeResize(element, measure);
  }, [contentElement, mode, measureUsageCard]);
  const card = (
    <div
      className={cn(
        "dropdown-glass isolate contain-paint grid max-h-full grid-rows-[minmax(0,1fr)] overflow-hidden rounded-2xl",
        mode === "popover" &&
          "max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))]",
      )}
      style={placement ? { maxHeight: placement.height } : undefined}
      data-thread-usage-card
    >
      <ScrollArea scrollFade className="min-h-0">
        <div ref={setContentElement}>{children}</div>
      </ScrollArea>
    </div>
  );
  return (
    <Popover
      handle={handle}
      open={mode === "popover" && popoverOpen}
      onOpenChange={(open) => useUsagePanelStore.getState().setOpen("popover", open)}
    >
      {placement && inlineOpen ? (
        <aside
          aria-label="Provider usage"
          className={cn(
            "absolute z-20",
            topInset > 0 && "transition-[top] duration-150 ease-out motion-reduce:transition-none",
          )}
          style={{
            right: placement.right,
            top: placement.y,
            width: placement.width,
            maxHeight: placement.height,
          }}
          data-thread-usage-panel="inline"
        >
          {card}
        </aside>
      ) : null}
      {/* Rendered in both modes for the same reason as the details card: a popup that
          unmounts mid-open stays mounted, so it must close in place when the card goes inline. */}
      <PopoverPopup
        role="dialog"
        anchor={anchor}
        align="end"
        alignOffset={THREAD_DETAILS_CARD_GAP - 8}
        collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
        side="bottom"
        sideOffset={topInset}
        variant="panel"
        padding="none"
      >
        {mode === "popover" ? <div data-thread-usage-panel="popover">{card}</div> : null}
      </PopoverPopup>
    </Popover>
  );
}

import { useEffect, useRef } from "react";

type Side = "top" | "bottom" | "left" | "right";

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };
const GAP = 6;
const EDGE = 8;

const isSide = (value: string | undefined): value is Side =>
  value === "top" || value === "bottom" || value === "left" || value === "right";

/** Where the tip box goes on one side of the anchor, before it is kept inside the viewport. */
function place(side: Side, anchor: DOMRect, tip: DOMRect) {
  const midX = anchor.left + anchor.width / 2 - tip.width / 2;
  const midY = anchor.top + anchor.height / 2 - tip.height / 2;
  switch (side) {
    case "top":
      return { x: midX, y: anchor.top - GAP - tip.height };
    case "bottom":
      return { x: midX, y: anchor.bottom + GAP };
    case "left":
      return { x: anchor.left - GAP - tip.width, y: midY };
    case "right":
      return { x: anchor.right + GAP, y: midY };
  }
}

/** Only the axis of the side counts: the other axis is clamped into the viewport anyway. */
const fits = (side: Side, at: { x: number; y: number }, tip: DOMRect) =>
  side === "top" || side === "bottom"
    ? at.y >= EDGE && at.y + tip.height <= innerHeight - EDGE
    : at.x >= EDGE && at.x + tip.width <= innerWidth - EDGE;

const clamp = (value: number, max: number) => Math.min(Math.max(value, EDGE), Math.max(EDGE, max));

/**
 * The one tooltip of the portal. Any element with `data-tip` shows it on hover or keyboard focus,
 * and `data-tip-side` picks the side (top by default). The tip sits in the top layer, so no card,
 * sticker or `overflow` hides it. It flips to the other side when it does not fit.
 */
export function Tooltip() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    let anchor: HTMLElement | null = null;
    const hide = () => {
      anchor = null;
      if (tip.matches(":popover-open")) tip.hidePopover();
    };
    const show = (next: HTMLElement) => {
      const text = next.dataset.tip;
      if (!text) return hide();
      anchor = next;
      tip.textContent = text;
      if (!tip.matches(":popover-open")) tip.showPopover();
      const box = tip.getBoundingClientRect();
      const rect = next.getBoundingClientRect();
      const side = isSide(next.dataset.tipSide) ? next.dataset.tipSide : "top";
      const first = place(side, rect, box);
      const at = fits(side, first, box) ? first : place(OPPOSITE[side], rect, box);
      tip.style.left = `${clamp(at.x, innerWidth - EDGE - box.width)}px`;
      tip.style.top = `${clamp(at.y, innerHeight - EDGE - box.height)}px`;
    };
    const tipOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;
    const onOver = (event: PointerEvent) => {
      const next = tipOf(event.target);
      if (next === anchor) return;
      if (next) show(next);
      else hide();
    };
    const onFocus = (event: FocusEvent) => {
      const next = tipOf(event.target);
      if (next?.matches(":focus-visible")) show(next);
    };
    const onBlur = (event: FocusEvent) => {
      if (tipOf(event.target) === anchor) hide();
    };
    const onOut = (event: PointerEvent) => {
      // The pointer left the page.
      if (event.relatedTarget === null) hide();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("keydown", onKey);
    // A press starts a drag or a click; the tip would cover the line or the next view.
    document.addEventListener("pointerdown", hide);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", hide);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);
  return <div ref={ref} popover="manual" className="tooltip" role="tooltip" />;
}

import { type PointerEvent, useRef } from "react";

const LONG_PRESS_MS = 450;

/**
 * Touch has no right-click or hover, so holding a control opens its options. Spread `handlers` on
 * the control, and have its click handler return early when `wasLongPress()` is true.
 */
export function useLongPress(onLongPress: () => void) {
  const press = useRef({
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    fired: false,
  });
  const cancel = () => clearTimeout(press.current.timer);
  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse") return;
      press.current.fired = false;
      press.current.timer = setTimeout(() => {
        press.current.fired = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: (event: { preventDefault: () => void }) => {
      event.preventDefault();
      onLongPress();
    },
    className: "select-none [-webkit-touch-callout:none]",
  };
  /** True once for the click that ends a long press. */
  const wasLongPress = () => {
    const { fired } = press.current;
    press.current.fired = false;
    return fired;
  };
  return { handlers, wasLongPress };
}

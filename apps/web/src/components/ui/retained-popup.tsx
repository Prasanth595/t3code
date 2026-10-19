"use client";

import { type ComponentProps, createContext, type ReactNode, use, useState } from "react";

// Base UI syncs a controlled `open` prop into the popup's state one render late, so the render
// that clears a dialog's content would still see it open. Roots publish the prop directly.
export const ControlledOpenContext = createContext<boolean | undefined>(undefined);

// Callers usually clear the state a dialog shows in the same update that closes it. Holding
// the last open children keeps the exit animation from snapping to empty or default content.
function RetainedWhileClosed({ open, children }: { open: boolean; children: ReactNode }) {
  const controlledOpen = use(ControlledOpenContext);
  const isOpen = open && controlledOpen !== false;
  const [retained, setRetained] = useState(children);
  if (isOpen && retained !== children) {
    setRetained(children);
  }
  return isOpen ? children : retained;
}

export function renderRetainedPopup(props: ComponentProps<"div">, state: { open: boolean }) {
  return (
    <div {...props}>
      <RetainedWhileClosed open={state.open}>{props.children}</RetainedWhileClosed>
    </div>
  );
}

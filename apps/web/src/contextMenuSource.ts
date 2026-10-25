import type { ContextMenuSource } from "@t3tools/contracts";

// Chromium fires a keyboard-opened `contextmenu` (Menu key, Shift+F10) with no button.
export function contextMenuSourceOf(event: Pick<MouseEvent, "button">): ContextMenuSource {
  return event.button === -1 ? "keyboard" : "mouse";
}

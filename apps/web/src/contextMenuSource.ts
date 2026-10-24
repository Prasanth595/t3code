import type { ContextMenuSource } from "@t3tools/contracts";

// Chromium fires a keyboard-opened `contextmenu` (Menu key, Shift+F10) with no
// button, and a keyboard-activated `click` with no click count.
export function contextMenuSourceOf(
  event: Pick<MouseEvent, "type" | "button" | "detail">,
): ContextMenuSource {
  const fromKeyboard = event.type === "contextmenu" ? event.button === -1 : event.detail === 0;
  return fromKeyboard ? "keyboard" : "mouse";
}

const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");

/**
 * Whether a text-editing element owns the keyboard. Shortcuts that share
 * their chord with native editing (mod+z) must yield when this is true.
 * Focus inside an open shadow root counts: a key event's target is retargeted
 * to the shadow host, so the host's focused descendant is what is typed into.
 */
export function isEditableFocused(target: EventTarget | null = document.activeElement): boolean {
  return focusedEditable(target) !== null;
}

function focusedEditable(target: EventTarget | null): Element | null {
  let element = target instanceof Element ? target : null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element?.closest(EDITABLE_SELECTOR) ?? null;
}

const editableUndoHistory = new WeakMap<Element, () => boolean>();

/** Lets an editor report its actual undo stack; native fields keep their keyboard. */
export function registerEditableUndoHistory(element: Element, canUndo: () => boolean) {
  editableUndoHistory.set(element, canUndo);
  return () => {
    editableUndoHistory.delete(element);
  };
}

/** An empty composer yields to thread undo only when its editor history is empty. */
export function editableOwnsUndo(target: EventTarget | null = document.activeElement): boolean {
  const element = focusedEditable(target);
  if (!element) return false;
  const canUndo = editableUndoHistory.get(element);
  // Native fields do not expose their undo stack, so preserve their shortcut.
  if (!canUndo) return true;
  return canUndo() || (element.textContent ?? "").length > 0;
}

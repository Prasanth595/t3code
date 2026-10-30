import type { ScopedThreadRef } from "@t3tools/contracts";

export interface ThreadRenameRequest {
  readonly threadRef: ScopedThreadRef;
  readonly returnFocus: HTMLElement | null;
}

const EVENT_NAME = "t3code:thread-rename";

export function openThreadRename(
  threadRef: ScopedThreadRef,
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null,
): void {
  window.dispatchEvent(
    new CustomEvent<ThreadRenameRequest>(EVENT_NAME, { detail: { threadRef, returnFocus } }),
  );
}

export function subscribeThreadRename(
  listener: (request: ThreadRenameRequest) => void,
): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ThreadRenameRequest>).detail);
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

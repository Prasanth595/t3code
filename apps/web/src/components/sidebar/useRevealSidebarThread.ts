import { useEffect, type RefObject } from "react";

export function useRevealSidebarThread(
  threadKey: string | null,
  listRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (threadKey === null) return;
    listRef.current
      ?.querySelector(`[data-thread-item="${globalThis.CSS.escape(threadKey)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [threadKey, listRef]);
}

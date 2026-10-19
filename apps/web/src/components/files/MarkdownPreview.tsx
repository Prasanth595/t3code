import { useEffect, useState, type ReactNode } from "react";
import { ThreadFindBar } from "../chat/ThreadFindBar";
import { MarkdownFindContext } from "../chat/markdownFindContext";
import { stepThreadFindIndex } from "../chat/threadFind";
import { useThreadFindHighlights } from "../chat/threadFindHighlights";
import { ScrollArea } from "../ui/scroll-area";
import { useStableCallback } from "~/hooks/useStableCallback";
import { MARKDOWN_FIND_OPEN_EVENT } from "./markdownFindActionBus";

export function MarkdownPreview({ children }: { children: ReactNode }) {
  const [preview, setPreview] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const activeIndex = Math.min(index, Math.max(0, matchCount - 1));
  const close = () => {
    setOpen(false);
    setQuery("");
    setIndex(0);
    preview?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!preview) return;
    const openFind = (event: Event) => {
      event.preventDefault();
      setOpen(true);
      setFocusRequestId((value) => value + 1);
    };
    preview.addEventListener(MARKDOWN_FIND_OPEN_EVENT, openFind);
    return () => preview.removeEventListener(MARKDOWN_FIND_OPEN_EVENT, openFind);
  }, [preview]);

  const reveal = useStableCallback((range: Range | null) => {
    const viewport = content?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!range || !viewport) return;
    for (
      let ancestor = range.startContainer.parentElement;
      ancestor && ancestor !== viewport;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor);
      const rect = range.getBoundingClientRect();
      const bounds = ancestor.getBoundingClientRect();
      const horizontal =
        /auto|scroll/.test(style.overflowX) && ancestor.scrollWidth > ancestor.clientWidth;
      const vertical =
        /auto|scroll/.test(style.overflowY) && ancestor.scrollHeight > ancestor.clientHeight;
      const left = horizontal
        ? rect.left < bounds.left
          ? rect.left - bounds.left - 16
          : Math.max(0, rect.right - bounds.right + 16)
        : 0;
      const top = vertical
        ? rect.top < bounds.top
          ? rect.top - bounds.top - 16
          : Math.max(0, rect.bottom - bounds.bottom + 16)
        : 0;
      if (left || top) ancestor.scrollBy({ left, top, behavior: "instant" });
    }
    const rect = range.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    if (rect.top < bounds.top + 60 || rect.bottom > bounds.bottom - 24) {
      viewport.scrollBy({ top: rect.top - bounds.top - bounds.height / 2, behavior: "instant" });
    }
  });
  useThreadFindHighlights({
    container: content,
    query: open ? query.trim() : "",
    activeRowId: "markdown-file",
    activeOccurrence: activeIndex,
    highlightPrefix: "t3-markdown-find",
    onMatchCountChange: setMatchCount,
    onActiveRange: reveal,
  });

  return (
    <div
      ref={setPreview}
      data-markdown-preview
      tabIndex={-1}
      className="relative flex min-h-0 flex-1 flex-col outline-none [--thread-details-panel-width:26rem]"
      onPointerDownCapture={(event) => {
        const interactive =
          event.target instanceof Element
            ? event.target.closest(
                "a, button, input, textarea, select, [tabindex], [contenteditable]",
              )
            : null;
        if (!interactive || interactive === preview) preview?.focus({ preventScroll: true });
      }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <ThreadFindBar
        label="Find in file"
        open={open}
        query={query}
        matchCount={matchCount}
        activeIndex={activeIndex}
        status={null}
        focusRequestId={focusRequestId}
        onRetry={() => {}}
        onQueryChange={(value) => {
          setQuery(value);
          setIndex(0);
        }}
        onNext={() => setIndex((current) => stepThreadFindIndex(current, matchCount, 1))}
        onPrevious={() => setIndex((current) => stepThreadFindIndex(current, matchCount, -1))}
        onClose={close}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div ref={setContent}>
          <div data-timeline-row-id="markdown-file">
            <div data-thread-find-text>
              <MarkdownFindContext value={open && query.trim().length > 0}>
                {children}
              </MarkdownFindContext>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

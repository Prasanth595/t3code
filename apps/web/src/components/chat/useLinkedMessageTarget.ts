import type { LegendListRef } from "@legendapp/list/react";
import type { RunId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { TimelineEntry } from "../../session-logic";
import type { LinkedMessageRequest } from "../promptLinks/ThreadLinkParams";
import { toastManager } from "../ui/toast";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/** Room above the linked message, so it does not sit flush against the top edge. */
const LINKED_MESSAGE_TOP_MARGIN = 24;
/** Index scrolling starts from estimates; stop correcting after about two seconds. */
const MAX_SETTLE_FRAMES = 120;

/**
 * Opens the timeline at a linked message: loads history through it, unfolds its turn, and
 * scrolls it to the top. A scroll, key, or click from the user ends the positioning.
 */
export function useLinkedMessageTarget({
  request,
  entries,
  rows,
  listRef,
  listReady,
  viewport,
  historyLoading,
  historyControls,
  onExpandTurn,
  onManualNavigation,
}: {
  request: LinkedMessageRequest | null;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: RefObject<LegendListRef | null>;
  listReady: boolean;
  viewport: HTMLElement | null;
  historyLoading: boolean;
  historyControls: MessagesTimelineHistoryControls | undefined;
  onExpandTurn: (runId: RunId) => void;
  onManualNavigation: () => void;
}) {
  const [finishedKey, setFinishedKey] = useState<string | null>(null);
  const progressRef = useRef<{
    key: string;
    requestedPages: Set<string>;
    expandedRunId: RunId | null;
  } | null>(null);
  const positioning = request !== null && finishedKey !== request.key;
  const rowId = positioning
    ? (rows.find(
        (candidate) => candidate.kind === "message" && candidate.message.id === request.messageId,
      )?.id ?? null)
    : null;
  const key = request?.key ?? null;

  // Without a row yet, load history through the message or unfold its turn.
  useEffect(() => {
    if (!request || !positioning || rowId !== null) return;
    if (progressRef.current?.key !== request.key) {
      progressRef.current = { key: request.key, requestedPages: new Set(), expandedRunId: null };
      onManualNavigation();
    }
    if (historyLoading) return;
    const progress = progressRef.current;
    const fail = (description: string) => {
      setFinishedKey(request.key);
      toastManager.add({
        type: "warning",
        title: "Could not open the linked message",
        description,
      });
    };
    const entry = entries.find(
      (candidate) => candidate.kind === "message" && candidate.message.id === request.messageId,
    );
    if (entry?.kind !== "message") {
      if (historyControls?.error) {
        fail(historyControls.error);
        return;
      }
      if (!historyControls?.hasMoreHistory) {
        fail("It is no longer in this thread.");
        return;
      }
      if (historyControls.loading) return;
      // Each page lands before the next request, so a cursor already asked for is still loading.
      const cursor = entries[0]?.id ?? "first";
      if (progress.requestedPages.has(cursor)) return;
      progress.requestedPages.add(cursor);
      historyControls.onLoadEarlier(request.messageId);
      return;
    }
    const runId = entry.message.runId;
    if (!runId || progress.expandedRunId === runId) {
      fail("Its turn could not be shown.");
      return;
    }
    progress.expandedRunId = runId;
    onExpandTurn(runId);
  }, [
    entries,
    historyControls,
    historyLoading,
    onExpandTurn,
    onManualNavigation,
    positioning,
    request,
    rowId,
  ]);

  // Scroll the row to the top, then correct for measured row sizes until it holds still.
  useEffect(() => {
    const list = listRef.current;
    if (key === null || rowId === null || !listReady || !list || !viewport) return;
    let stopped = false;
    let frame: number | null = null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (frame !== null) cancelAnimationFrame(frame);
      setFinishedKey(key);
    };
    const cancelForUser = () => {
      if (stopped) return;
      stop();
      // Supersede a queued list scroll before the user's gesture runs.
      void list.scrollToOffset({ offset: viewport.scrollTop, animated: false });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        cancelForUser();
    };
    viewport.addEventListener("wheel", cancelForUser, { passive: true });
    viewport.addEventListener("touchmove", cancelForUser, { passive: true });
    viewport.addEventListener("pointerdown", cancelForUser, { passive: true });
    viewport.ownerDocument.addEventListener("keydown", onKeyDown);

    let frames = 0;
    let stableFrames = 0;
    const settle = () => {
      frame = null;
      if (stopped) return;
      if (++frames > MAX_SETTLE_FRAMES) {
        stop();
        return;
      }
      const state = list.getState();
      const index = state.indexByKey(rowId);
      const element = index === undefined ? undefined : state.elementAtIndex(index);
      if (!element) {
        frame = requestAnimationFrame(settle);
        return;
      }
      const offset = Math.max(
        0,
        Math.min(
          viewport.scrollTop +
            element.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top -
            LINKED_MESSAGE_TOP_MARGIN,
          viewport.scrollHeight - viewport.clientHeight,
        ),
      );
      if (Math.abs(viewport.scrollTop - offset) > 1) {
        stableFrames = 0;
        void list.scrollToOffset({ offset, animated: false }).then(() => {
          if (!stopped) frame = requestAnimationFrame(settle);
        });
      } else if (++stableFrames >= 2) {
        stop();
        // ChatView's thread-open effect can run after the opt-out at the start.
        onManualNavigation();
      } else {
        frame = requestAnimationFrame(settle);
      }
    };
    const index = list.getState().indexByKey(rowId);
    void Promise.resolve(
      index === undefined
        ? undefined
        : list.scrollToIndex({
            index,
            animated: false,
            viewPosition: 0,
            viewOffset: LINKED_MESSAGE_TOP_MARGIN,
          }),
    ).then(() => {
      if (!stopped) frame = requestAnimationFrame(settle);
    });
    return () => {
      stopped = true;
      if (frame !== null) cancelAnimationFrame(frame);
      viewport.removeEventListener("wheel", cancelForUser);
      viewport.removeEventListener("touchmove", cancelForUser);
      viewport.removeEventListener("pointerdown", cancelForUser);
      viewport.ownerDocument.removeEventListener("keydown", onKeyDown);
    };
  }, [key, listReady, listRef, onManualNavigation, rowId, viewport]);

  return {
    positioning,
    pinnedRowId: rowId,
    alwaysRender: useMemo(() => (rowId === null ? undefined : { keys: [rowId] }), [rowId]),
  };
}

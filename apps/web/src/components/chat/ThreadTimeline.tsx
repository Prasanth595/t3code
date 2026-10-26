import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  coordinationItemHeader,
  coordinationItemPreview,
  coordinationItemText,
  coordinationTurnItems,
  FINISHED_WITHOUT_USER_UPDATE_NOTICE,
  runFinishedWithoutUserUpdate,
} from "@t3tools/client-runtime/state/thread-communication";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { type ComponentProps, useLayoutEffect, useState } from "react";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import type { TimelineEntriesInput, TimelineEntry } from "../../session-logic";
import { useThreadVisibleTurnItems } from "../../state/entities";
import { useTurnItemDetail } from "../../state/queries";
import {
  peekRememberedThreadTimeline,
  rememberReadyThreadTimeline,
  resolveThreadSwitchTimeline,
  timelineHasEphemeralPreviewUrls,
} from "../ChatView.logic";
import { MessagesTimeline } from "./MessagesTimeline";

/**
 * The timeline with the streamed text. ChatView reads the thread through its quiet
 * atoms, which hold through text deltas; this reads the live turn items, so a
 * delta re-renders the timeline without re-rendering ChatView.
 */
export function ThreadTimeline({
  threadDetailRef,
  entriesInput,
  draftEntries,
  activeThreadKey,
  syncing,
  detailLoading,
  readyMarkdownCwd,
  readyWorkspaceRoot,
  communicationLanesEnabled = false,
  ...timelineProps
}: Omit<ComponentProps<typeof MessagesTimeline>, "timelineEntries"> & {
  /** Null until the thread's detail may load; see resolveThreadDetailRef. */
  threadDetailRef: ScopedThreadRef | null;
  entriesInput: Omit<TimelineEntriesInput, "visibleTurnItems">;
  /** A local draft's optimistic rows; null for a server thread. */
  draftEntries: ReadonlyArray<TimelineEntry> | null;
  activeThreadKey: string | null;
  syncing: boolean;
  detailLoading: boolean;
  readyMarkdownCwd: string | null;
  readyWorkspaceRoot: string | null;
  communicationLanesEnabled?: boolean;
}) {
  const visibleTurnItems = useThreadVisibleTurnItems(threadDetailRef);
  const [coordinationOpen, setCoordinationOpen] = useState(false);
  const [coordinationVisibleCount, setCoordinationVisibleCount] = useState(100);
  const [selectedCoordinationId, setSelectedCoordinationId] = useState<string | null>(null);
  const coordinationItems = coordinationTurnItems(visibleTurnItems, communicationLanesEnabled);
  const selectedCoordinationItem = coordinationOpen
    ? coordinationItems.find(({ item }) => item.id === selectedCoordinationId)
    : undefined;
  const coordinationDetail = useTurnItemDetail(
    selectedCoordinationItem && threadDetailRef
      ? {
          environmentId: threadDetailRef.environmentId,
          threadId: selectedCoordinationItem.sourceThreadId,
          itemId: selectedCoordinationItem.sourceItemId,
          revision: turnItemDetailRevision(selectedCoordinationItem.item),
        }
      : null,
  );
  const finishedWithoutUpdate =
    communicationLanesEnabled &&
    runFinishedWithoutUserUpdate(
      visibleTurnItems,
      timelineProps.latestRun?.runId,
      timelineProps.latestRun?.status,
    );
  const serverEntries = useIncrementalTimelineEntries(activeThreadKey, {
    ...entriesInput,
    visibleTurnItems,
    communicationLanesEnabled,
  });
  const entries = draftEntries ?? serverEntries;
  const displayed = resolveThreadSwitchTimeline({
    loading: entries.length === 0 && syncing,
    activeThreadKey,
    nextEntries: entries,
    rememberedForActive: peekRememberedThreadTimeline<typeof entries>(activeThreadKey),
  });
  useLayoutEffect(() => {
    if (detailLoading || entries.length === 0 || timelineHasEphemeralPreviewUrls(entries)) {
      return;
    }
    rememberReadyThreadTimeline({
      threadKey: activeThreadKey,
      entries,
      markdownCwd: readyMarkdownCwd,
      workspaceRoot: readyWorkspaceRoot,
    });
  }, [activeThreadKey, detailLoading, entries, readyMarkdownCwd, readyWorkspaceRoot]);
  return (
    <>
      {communicationLanesEnabled ? (
        <section
          className="shrink-0 border-b border-border bg-background"
          aria-label="Coordination activity"
        >
          {finishedWithoutUpdate ? (
            <p className="px-4 pt-2 text-xs text-muted-foreground">
              {FINISHED_WITHOUT_USER_UPDATE_NOTICE}
            </p>
          ) : null}
          <button
            type="button"
            aria-expanded={coordinationOpen}
            onClick={() => setCoordinationOpen((open) => !open)}
            className="w-full px-4 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Coordination ({coordinationItems.length}) · Compatibility mode{" "}
            {coordinationOpen ? "▴" : "▾"}
          </button>
          {coordinationOpen ? (
            <div className="max-h-[40vh] overflow-y-auto border-t border-border px-4 py-2">
              {coordinationItems.length === 0 ? (
                <p className="text-xs text-muted-foreground">No coordination activity yet.</p>
              ) : (
                <ol className="space-y-3">
                  {coordinationItems.length > coordinationVisibleCount ? (
                    <li>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground underline"
                        onClick={() => setCoordinationVisibleCount((count) => count + 100)}
                      >
                        Show earlier coordination activity
                      </button>
                    </li>
                  ) : null}
                  {coordinationItems.slice(-coordinationVisibleCount).map(({ item }) => (
                    <li key={item.id} className="text-xs">
                      <button
                        type="button"
                        className="w-full text-left"
                        aria-expanded={selectedCoordinationId === item.id}
                        onClick={() =>
                          setSelectedCoordinationId((id) => (id === item.id ? null : item.id))
                        }
                      >
                        <span className="block font-medium text-muted-foreground">
                          {coordinationItemHeader(item)}
                        </span>
                        <span className="block whitespace-pre-wrap break-words text-foreground">
                          {coordinationItemPreview(item)}
                        </span>
                      </button>
                      {selectedCoordinationId === item.id ? (
                        <div className="mt-2 whitespace-pre-wrap break-words rounded border border-border p-2 text-foreground">
                          {coordinationDetail.isPending
                            ? "Loading full activity…"
                            : (coordinationDetail.error ??
                              (coordinationDetail.data?.item
                                ? coordinationItemText(coordinationDetail.data.item)
                                : "Full activity unavailable."))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
      <MessagesTimeline {...timelineProps} timelineEntries={displayed.entries} />
    </>
  );
}

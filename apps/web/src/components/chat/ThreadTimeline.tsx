import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  FINISHED_WITHOUT_USER_UPDATE_NOTICE,
  runFinishedWithoutUserUpdate,
} from "@t3tools/client-runtime/state/thread-communication";
import { type ComponentProps, useLayoutEffect } from "react";
import { useIncrementalTimelineEntries } from "../../hooks/useIncrementalTimelineEntries";
import type { TimelineEntriesInput, TimelineEntry } from "../../session-logic";
import { useThreadVisibleTurnItems } from "../../state/entities";
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
  const footer = finishedWithoutUpdate ? (
    <>
      {timelineProps.footer}
      <p className="chat-content-lane py-2 text-xs text-muted-foreground">
        {FINISHED_WITHOUT_USER_UPDATE_NOTICE}
      </p>
    </>
  ) : (
    timelineProps.footer
  );
  return (
    <MessagesTimeline {...timelineProps} footer={footer} timelineEntries={displayed.entries} />
  );
}

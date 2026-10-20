import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadFeedMessage } from "../../lib/threadActivity";

/** Local feedback and anchored creation prompts have no persisted server turn item. */
export function persistedMessageLink(threadRef: ScopedThreadRef, message: ThreadFeedMessage) {
  return message.projectedItem === undefined ? null : { ...threadRef, messageId: message.id };
}

/**
 * The next thing the feed does to open at a linked message. Used by `ThreadFeed` until it scrolls
 * to the message or reports it missing.
 */
export function resolveLinkedMessageStep(input: {
  /** The message is a row of the presented feed. */
  readonly presented: boolean;
  /** The thread holds the message, even if the feed does not present it. */
  readonly inFeed: boolean;
  /** The collapsed turn that hides the message, when one does. */
  readonly foldedRunId: string | null;
  /** The thread has caught up with the server, so a message it lacks is older history. */
  readonly synced: boolean;
  readonly historyLoading: boolean;
  /** Why the last history load failed, when it did. */
  readonly historyError: string | null;
  readonly hasMoreHistory: boolean;
  /** The last load through the message finished without changing the feed. */
  readonly lastLoadChangedNothing: boolean;
}): "scroll" | "expand" | "wait" | "load" | "missing" | "failed" {
  // A sync snapshot or history page can replace a cached row before scrolling.
  if (input.historyLoading || !input.synced) return "wait";
  if (input.presented) return "scroll";
  if (input.foldedRunId !== null) return "expand";
  // Loaded but hidden by something other than a fold: more history cannot reveal it.
  if (input.inFeed) return "missing";
  if (input.historyError !== null) return "failed";
  if (!input.hasMoreHistory) return "missing";
  // Older history remains, so a load that returned nothing failed rather than ran out.
  return input.lastLoadChangedNothing ? "failed" : "load";
}

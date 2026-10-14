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
  /** Earlier history remains, and the last load through the message changed the feed. */
  readonly canLoadEarlier: boolean;
}): "scroll" | "expand" | "wait" | "load" | "missing" {
  if (input.presented) return "scroll";
  if (input.foldedRunId !== null) return "expand";
  // Loaded but hidden by something other than a fold: more history cannot reveal it.
  if (input.inFeed) return "missing";
  if (!input.synced || input.historyLoading) return "wait";
  return input.canLoadEarlier ? "load" : "missing";
}

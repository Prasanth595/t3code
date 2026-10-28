import { THREAD_WORK_ROW_MIN_HEIGHT } from "../../lib/layout";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

export function resolveThreadFeedFixedItemSize(
  entryType: ThreadFeedEntry["type"],
): number | undefined {
  // Fixed sizing bypasses native measurement; folds can wrap with trajectory segments.
  return entryType === "work-toggle" ? THREAD_WORK_ROW_MIN_HEIGHT : undefined;
}

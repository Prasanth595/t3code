import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { isOrchestrationV2TurnItemVisible } from "@t3tools/shared/orchestrationV2Timeline";

export type ThreadHistoryMeta = {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  /** True after at least one older page was merged; skip monolithic cache growth. */
  readonly expanded: boolean;
  /**
   * Max local turn ordinal known for partial progressive windows. Null when
   * unknown (legacy cache) or when history meta is cleared for a full snapshot.
   */
  readonly latestLocalTurnOrdinal: number | null;
};

export const EMPTY_THREAD_HISTORY_META: ThreadHistoryMeta = {
  historyCursor: null,
  hasMoreHistory: false,
  loading: false,
  error: null,
  expanded: false,
  latestLocalTurnOrdinal: null,
};

/** Whether a history-page response still matches the cursor that started it. */
export function isActiveHistoryRequestCursor(
  requestCursor: string,
  history: { readonly historyCursor: string | null },
): boolean {
  return history.historyCursor === requestCursor;
}

/**
 * Clear history loading after an interrupted load-earlier only when the
 * request cursor is still active. Does not touch stream/status/error.
 */
export function clearActiveHistoryLoading(
  requestCursor: string,
  history: ThreadHistoryMeta,
): ThreadHistoryMeta {
  if (!isActiveHistoryRequestCursor(requestCursor, history) || !history.loading) {
    return history;
  }
  return { ...history, loading: false };
}

function projectedItemKey(row: OrchestrationV2ProjectedTurnItem): string {
  return `${row.sourceThreadId}:${row.sourceItemId}`;
}

type HistoryMergeIndex = {
  projection: OrchestrationV2ThreadProjection;
  visible: Map<string, OrchestrationV2ProjectedTurnItem>;
  local: Map<string, OrchestrationV2ThreadProjection["turnItems"][number]>;
};
const historyMergeIndexes = new WeakMap<OrchestrationV2ThreadProjection, HistoryMergeIndex>();

function historyMergeIndex(projection: OrchestrationV2ThreadProjection): HistoryMergeIndex {
  const cached = historyMergeIndexes.get(projection);
  if (cached?.projection === projection) return cached;
  const index = {
    projection,
    visible: new Map(projection.visibleTurnItems.map((row) => [projectedItemKey(row), row])),
    local: new Map(projection.turnItems.map((item) => [String(item.id), item])),
  };
  historyMergeIndexes.set(projection, index);
  return index;
}

/**
 * Merge an older history page into the live projection. Dedupes by
 * sourceThreadId + sourceItemId, keeps chronological order (older first), and
 * preserves newer live rows already present in state.
 */
export function mergeOlderHistoryIntoProjection(
  projection: OrchestrationV2ThreadProjection,
  olderItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ThreadProjection {
  if (olderItems.length === 0) {
    return projection;
  }

  const index = historyMergeIndex(projection);
  const currentByKey = index.visible;
  const turnItemById = index.local;
  const newLocalItems = new Map<string, OrchestrationV2ThreadProjection["turnItems"][number]>();
  let overlaps = false;
  const pageKeys = new Set<string>();
  const page: OrchestrationV2ProjectedTurnItem[] = [];
  for (const pageRow of olderItems) {
    const key = projectedItemKey(pageRow);
    if (pageKeys.has(key)) continue;
    let row = currentByKey.get(key) ?? pageRow;
    if (
      !currentByKey.has(key) &&
      (row.visibility === "local" || row.sourceThreadId === projection.thread.id)
    ) {
      const currentItem =
        turnItemById.get(String(row.sourceItemId)) ?? newLocalItems.get(String(row.sourceItemId));
      // Hidden live items stay hidden. Cold snapshots also retain interrupt
      // requests outside the visible window; paging may reveal those requests.
      if (currentItem !== undefined) {
        if (
          currentItem.type !== "run_interrupt_request" ||
          !isOrchestrationV2TurnItemVisible({
            item: currentItem,
            runs: projection.runs,
            attempts: projection.attempts,
            items: projection.turnItems,
          })
        )
          continue;
        row = { ...row, item: currentItem };
      }
    }
    pageKeys.add(key);
    page.push(row);
    overlaps ||= currentByKey.has(key);
    if (
      (row.visibility === "local" || row.sourceThreadId === projection.thread.id) &&
      !turnItemById.has(String(row.sourceItemId)) &&
      !newLocalItems.has(String(row.sourceItemId))
    ) {
      newLocalItems.set(String(row.sourceItemId), row.item);
    }
  }
  if (page.length === 0) return projection;
  // Server page order fills gaps between rows from a partial conversation load.
  // Existing rows supply live values; rows outside this range keep their order.
  const visible = [
    ...page,
    ...(overlaps
      ? projection.visibleTurnItems.filter((row) => !pageKeys.has(projectedItemKey(row)))
      : projection.visibleTurnItems),
  ];
  if (
    visible.length === projection.visibleTurnItems.length &&
    visible.every((row, index) => row === projection.visibleTurnItems[index])
  )
    return projection;
  const merged = {
    ...projection,
    turnItems:
      newLocalItems.size === 0
        ? projection.turnItems
        : [...projection.turnItems, ...newLocalItems.values()],
    // The client follows array order; server cursors independently carry
    // canonical positions. Keep existing row identities across prepends.
    visibleTurnItems: visible,
  };
  for (const row of page) currentByKey.set(projectedItemKey(row), row);
  for (const [id, item] of newLocalItems) turnItemById.set(id, item);
  // Advance only this index's owner. A merge against an older projection or a
  // live reducer result rebuilds its own index instead of using future rows.
  index.projection = merged;
  historyMergeIndexes.set(merged, index);
  return merged;
}

export function applyHistoryPageMeta(
  current: ThreadHistoryMeta,
  page: {
    readonly nextCursor: string | null;
    readonly hasMoreHistory: boolean;
  },
): ThreadHistoryMeta {
  return {
    historyCursor: page.nextCursor,
    hasMoreHistory: page.hasMoreHistory,
    loading: false,
    error: null,
    expanded: true,
    // Preserve the partial-timeline watermark across load-earlier pages.
    latestLocalTurnOrdinal: current.latestLocalTurnOrdinal,
  };
}

/** Whether a client timeline should render its load-earlier control. */
export function shouldShowLoadEarlierControl(history: ThreadHistoryMeta): boolean {
  return history.hasMoreHistory || history.error !== null;
}

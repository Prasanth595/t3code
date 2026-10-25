import { useState } from "react";

import { sidebarListItemId, type SidebarListItem } from "../Sidebar.logic";

const listKeyOf = (items: readonly SidebarListItem[]) =>
  items
    .map((item) => (item.kind === "thread" ? item.section + ":" + item.key : item.marker))
    .join("\n");

/**
 * The live thread list and every project switcher page's list, each keeping
 * its items and sortable ids until a row moves, changes section, arrives, or
 * leaves.
 *
 * Thread shells update on every streamed event without moving rows, and
 * dnd-kit compares `items` by identity: a new array gives SortableContext a new
 * context value and gives every useSortable row a frame with transitions off,
 * re-rendering each row twice. Lists are matched by content, not by position,
 * so a page keeps its arrays as a swipe or a pick moves it between live,
 * neighbour and passed-through. Only the lists of the current render are kept.
 */
export function useStableSidebarLists<T>(
  live: readonly SidebarListItem[],
  pages: readonly T[],
  listOf: (page: T) => readonly SidebarListItem[],
) {
  const [kept, setKept] = useState<
    ReadonlyArray<{ key: string; listItems: readonly SidebarListItem[]; sortableIds: string[] }>
  >([]);
  const current: Array<(typeof kept)[number]> = [];
  const stableOf = (items: readonly SidebarListItem[]) => {
    const key = listKeyOf(items);
    const list = current.find((entry) => entry.key === key) ??
      kept.find((entry) => entry.key === key) ?? {
        key,
        listItems: items,
        sortableIds: items.map(sidebarListItemId),
      };
    if (!current.includes(list)) current.push(list);
    return list;
  };
  const lists = {
    live: stableOf(live),
    pages: pages.map((page) => ({ page, list: stableOf(listOf(page)) })),
  };
  if (current.length !== kept.length || current.some((list, index) => list !== kept[index])) {
    setKept(current);
  }
  // The rest of this render still runs before React applies the update, and
  // threadByKey already lacks rows that just left, such as a thread settled
  // into the collapsed Settled shelf.
  return lists;
}

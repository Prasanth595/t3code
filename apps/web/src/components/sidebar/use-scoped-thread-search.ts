import {
  nextShownOrder,
  threadSearchMatchKey,
  threadSearchSubject,
  type EnvironmentThreadSearchMatch,
  type ShownOrder,
  type ThreadSearchShell,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankMessageMatches } from "@t3tools/shared/paletteSearch";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { searchSidebarThreads } from "../Sidebar.logic";

/**
 * One thread search, narrowed to the selected scope and, through
 * `searchScope`, to any other project switcher page. The server's matches cover every project, so
 * each page keeps only its own threads, in the order the selected scope will
 * show them once a swipe lands there.
 */
export function useScopedThreadSearch<
  T extends ThreadSearchShell & { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(input: {
  readonly query: string;
  readonly search: {
    readonly query: string;
    readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  };
  readonly live: readonly T[];
}) {
  const { query, search } = input;
  // Rows already shown keep their places while slower environments answer.
  const [shownOrder, setShownOrder] = useState<ShownOrder | null>(null);
  // oxlint-disable-next-line react/purity -- Recency ranking samples the clock when matches change, as in the main sidebar.
  const now = Date.now();
  // Ranked across environments as the palette ranks them, so one
  // environment's list does not sit above another's better matches. Every
  // page runs on each thread-shell update, so nothing is indexed until the
  // server has matches.
  const rankedMatchesIn = (threads: readonly T[]) => {
    if (search.matches.length === 0) return [];
    const threadByMatchKey = new Map(
      threads.map((thread) => [
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
        thread,
      ]),
    );
    return rankMessageMatches(
      search.matches,
      (match) => {
        const thread = threadByMatchKey.get(threadSearchMatchKey(match));
        return thread ? threadSearchSubject(thread, null) : undefined;
      },
      foldSearchQuery(query),
      now,
      // A list filter, as on mobile: a pick would move rows unexplained.
      { picks: false },
    );
  };
  const searchScope = (threads: readonly T[]) => {
    const rankedMatches = rankedMatchesIn(threads);
    const matchByKey = new Map(
      rankedMatches.map((match) => [threadSearchMatchKey(match), match] as const),
    );
    // A neighbouring page orders from the live page's shown order too, exactly
    // as the live page will once it becomes the selected scope.
    const order = nextShownOrder(
      shownOrder,
      search.query,
      [...matchByKey.keys()],
      Number.POSITIVE_INFINITY,
    );
    const { titleMatches, contentMatches } = searchSidebarThreads(
      threads,
      query,
      new Set(order.keys),
      now,
    );
    return {
      order,
      results: [...titleMatches, ...contentMatches],
      // Only rows listed for their messages show one, and open find on it.
      matchByKey: new Map(
        contentMatches.flatMap((thread) => {
          const key = threadSearchMatchKey({
            environmentId: thread.environmentId,
            threadId: thread.id,
          });
          const match = matchByKey.get(key);
          return match ? [[key, match] as const] : [];
        }),
      ),
    };
  };
  const live = searchScope(input.live);
  if (live.order !== shownOrder) setShownOrder(live.order);
  return { live, searchScope };
}

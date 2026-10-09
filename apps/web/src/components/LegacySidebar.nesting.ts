import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sortThreads, type ThreadSortInput } from "../lib/threadSort";
import type { SidebarThreadSummary } from "../types";

type NestableSidebarThread = Pick<
  SidebarThreadSummary,
  "environmentId" | "id" | "archivedAt" | "lineage"
> &
  ThreadSortInput;

export interface LegacySidebarThreadRow<TThread extends NestableSidebarThread> {
  readonly thread: TThread;
  /** 0 for a top-level row; 1+ marks a subagent row nested under its parent. */
  readonly nestingDepth: number;
  /** Direct subagent children of this thread that are present in the list. */
  readonly subagentChildCount: number;
  /** Whether this row's subagent children render. Collapsed is the default. */
  readonly subagentChildrenExpanded: boolean;
}

export interface LegacySidebarThreadListInput<TThread extends NestableSidebarThread> {
  /** The project's threads in any order; archived threads are dropped. */
  readonly threads: readonly TThread[];
  readonly sortOrder: SidebarThreadSortOrder;
  /** "Show more" preview limit for the project's top-level rows. */
  readonly previewCount: number;
  /** Whether the project's thread list is expanded past the preview limit. */
  readonly listExpanded: boolean;
  readonly projectExpanded: boolean;
  /** Scoped key of the open route's thread, null when none is open. */
  readonly activeThreadKey: string | null;
  /** Scoped keys of parents whose subagent children the user expanded. */
  readonly expandedSubagentParentKeys: ReadonlySet<string>;
}

export interface LegacySidebarThreadList<TThread extends NestableSidebarThread> {
  /** Rows in display order: top-level threads, then their expanded children. */
  readonly rows: ReadonlyArray<LegacySidebarThreadRow<TThread>>;
  /** Unarchived threads in sort order, for status pills and range selection. */
  readonly visibleThreads: readonly TThread[];
  /** Top-level threads (parents, forks and orphan subagents) in sort order. */
  readonly topLevelThreads: readonly TThread[];
  /** Top-level threads the preview limit cut off, for the "Show more" status. */
  readonly hiddenTopLevelThreads: readonly TThread[];
  /** The open thread rendered alone while its project is collapsed. */
  readonly pinnedCollapsedThread: TThread | null;
}

function nestableThreadKey(thread: NestableSidebarThread): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/** A subagent's parent key in its own environment, or null when the lineage is
 *  absent or self-referential (which would loop the nesting walk). */
function subagentParentThreadKey(thread: NestableSidebarThread): string | null {
  if (thread.lineage.relationshipToParent !== "subagent") return null;
  const parentThreadId = thread.lineage.parentThreadId;
  if (parentThreadId === null || parentThreadId === thread.id) return null;
  return scopedThreadKey(scopeThreadRef(thread.environmentId, parentThreadId));
}

/** Lays out one project's legacy sidebar thread list: subagent threads nest
 *  under their parent, collapsed by default, while forks and subagents whose
 *  parent is not in the list stay flat top-level rows so no thread is lost. */
export function buildLegacySidebarThreadList<TThread extends NestableSidebarThread>(
  input: LegacySidebarThreadListInput<TThread>,
): LegacySidebarThreadList<TThread> {
  const {
    threads,
    sortOrder,
    previewCount,
    listExpanded,
    projectExpanded,
    activeThreadKey,
    expandedSubagentParentKeys,
  } = input;
  const visibleThreads = sortThreads(
    threads.filter((thread) => thread.archivedAt === null),
    sortOrder,
  );
  const threadByKey = new Map(
    visibleThreads.map((thread) => [nestableThreadKey(thread), thread] as const),
  );

  const subagentsByParentKey = new Map<string, TThread[]>();
  const nestedThreadKeys = new Set<string>();
  for (const thread of visibleThreads) {
    const parentKey = subagentParentThreadKey(thread);
    if (parentKey === null || !threadByKey.has(parentKey)) continue;
    nestedThreadKeys.add(nestableThreadKey(thread));
    const siblings = subagentsByParentKey.get(parentKey);
    if (siblings) {
      siblings.push(thread);
    } else {
      subagentsByParentKey.set(parentKey, [thread]);
    }
  }

  // The open thread's ancestor chain always renders expanded, so the active
  // row is never hidden behind its own parent's collapsed state.
  const forceExpandedKeys = new Set<string>();
  if (activeThreadKey !== null) {
    const visited = new Set<string>([activeThreadKey]);
    let cursor = threadByKey.get(activeThreadKey) ?? null;
    while (cursor !== null) {
      const parentKey = subagentParentThreadKey(cursor);
      if (parentKey === null || !threadByKey.has(parentKey) || visited.has(parentKey)) break;
      visited.add(parentKey);
      forceExpandedKeys.add(parentKey);
      cursor = threadByKey.get(parentKey) ?? null;
    }
  }

  const topLevelThreads = visibleThreads.filter(
    (thread) => !nestedThreadKeys.has(nestableThreadKey(thread)),
  );
  const pinnedCollapsedThread =
    projectExpanded || activeThreadKey === null ? null : (threadByKey.get(activeThreadKey) ?? null);

  const hasOverflowingThreads = topLevelThreads.length > previewCount;
  const previewTopLevelThreads =
    listExpanded || !hasOverflowingThreads
      ? topLevelThreads
      : topLevelThreads.slice(0, previewCount);
  const previewKeys = new Set(previewTopLevelThreads.map(nestableThreadKey));
  if (pinnedCollapsedThread !== null) {
    previewKeys.add(nestableThreadKey(pinnedCollapsedThread));
  }
  const hiddenTopLevelThreads = topLevelThreads.filter(
    (thread) => !previewKeys.has(nestableThreadKey(thread)),
  );

  const rows: LegacySidebarThreadRow<TThread>[] = [];
  if (pinnedCollapsedThread !== null) {
    // A collapsed project shows only the open thread, standalone and flat,
    // without its nesting affordance.
    rows.push({
      thread: pinnedCollapsedThread,
      nestingDepth: 0,
      subagentChildCount: 0,
      subagentChildrenExpanded: false,
    });
  } else if (projectExpanded) {
    const emittedKeys = new Set<string>();
    const emitRow = (thread: TThread, nestingDepth: number) => {
      const key = nestableThreadKey(thread);
      // Lineage is assigned from an existing parent at spawn time, so cycles
      // cannot occur; the guard only keeps corrupt data from looping the walk.
      if (emittedKeys.has(key)) return;
      emittedKeys.add(key);
      const children = subagentsByParentKey.get(key) ?? [];
      const expanded =
        children.length > 0 && (expandedSubagentParentKeys.has(key) || forceExpandedKeys.has(key));
      rows.push({
        thread,
        nestingDepth,
        subagentChildCount: children.length,
        subagentChildrenExpanded: expanded,
      });
      if (!expanded) return;
      for (const child of children) {
        emitRow(child, nestingDepth + 1);
      }
    };
    for (const thread of previewTopLevelThreads) {
      emitRow(thread, 0);
    }
  }

  return {
    rows,
    visibleThreads,
    topLevelThreads,
    hiddenTopLevelThreads,
    pinnedCollapsedThread,
  };
}

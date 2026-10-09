import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import type { Thread } from "../types";
import {
  buildLegacySidebarThreadList,
  type LegacySidebarThreadListInput,
} from "./LegacySidebar.nesting";

const environmentId = EnvironmentId.make("environment-nesting");
const projectId = ProjectId.make("project-nesting");

const parentId = ThreadId.make("thread-parent");
const siblingId = ThreadId.make("thread-sibling");
const subagentOneId = ThreadId.make("thread-run-a");
const subagentTwoId = ThreadId.make("thread-run-b");

function threadKey(threadId: ThreadId, env = environmentId): string {
  return scopedThreadKey(scopeThreadRef(env, threadId));
}

function makeListThread(overrides: ThreadFixtureOverrides): Thread {
  return makeThreadFixture({ environmentId, projectId, ...overrides });
}

function subagentLineage(rootThreadId: ThreadId, parentThreadId: ThreadId): Thread["lineage"] {
  return { rootThreadId, parentThreadId, relationshipToParent: "subagent" };
}

function buildList(
  threads: readonly Thread[],
  overrides: Partial<LegacySidebarThreadListInput<Thread>> = {},
) {
  return buildLegacySidebarThreadList({
    threads,
    sortOrder: "updated_at",
    previewCount: 10,
    listExpanded: false,
    projectExpanded: true,
    activeThreadKey: null,
    expandedSubagentParentKeys: new Set(),
    ...overrides,
  });
}

function rowShapes(list: ReturnType<typeof buildList>) {
  return list.rows.map((row) => ({
    id: row.thread.id as string,
    depth: row.nestingDepth,
    children: row.subagentChildCount,
    expanded: row.subagentChildrenExpanded,
  }));
}

function makeProjectThreads(): Thread[] {
  return [
    makeListThread({
      id: parentId,
      title: "Parent",
      latestUserMessageAt: "2026-01-03T00:00:00.000Z",
    }),
    makeListThread({
      id: subagentOneId,
      title: "Run A",
      latestUserMessageAt: "2026-01-02T00:00:00.000Z",
      lineage: subagentLineage(parentId, parentId),
    }),
    makeListThread({
      id: subagentTwoId,
      title: "Run B",
      latestUserMessageAt: "2026-01-01T00:00:00.000Z",
      lineage: subagentLineage(parentId, parentId),
    }),
    makeListThread({
      id: siblingId,
      title: "Sibling",
      latestUserMessageAt: "2026-01-04T00:00:00.000Z",
    }),
  ];
}

describe("buildLegacySidebarThreadList", () => {
  it("nests subagent children under their parent, collapsed by default", () => {
    const list = buildList(makeProjectThreads());

    expect(rowShapes(list)).toEqual([
      { id: siblingId, depth: 0, children: 0, expanded: false },
      { id: parentId, depth: 0, children: 2, expanded: false },
    ]);
    expect(list.topLevelThreads.map((thread) => thread.id)).toEqual([siblingId, parentId]);
    expect(list.visibleThreads.map((thread) => thread.id)).toEqual([
      siblingId,
      parentId,
      subagentOneId,
      subagentTwoId,
    ]);
  });

  it("renders expanded subagent children under their parent in sort order", () => {
    const list = buildList(makeProjectThreads(), {
      expandedSubagentParentKeys: new Set([threadKey(parentId)]),
    });

    expect(rowShapes(list)).toEqual([
      { id: siblingId, depth: 0, children: 0, expanded: false },
      { id: parentId, depth: 0, children: 2, expanded: true },
      { id: subagentOneId, depth: 1, children: 0, expanded: false },
      { id: subagentTwoId, depth: 1, children: 0, expanded: false },
    ]);
  });

  it("auto-expands the ancestor chain of the open thread", () => {
    const grandchildId = ThreadId.make("thread-grandchild");
    const threads = [
      ...makeProjectThreads(),
      makeListThread({
        id: grandchildId,
        title: "Nested run",
        latestUserMessageAt: "2026-01-05T00:00:00.000Z",
        lineage: subagentLineage(parentId, subagentOneId),
      }),
    ];

    const list = buildList(threads, { activeThreadKey: threadKey(grandchildId) });

    expect(rowShapes(list)).toEqual([
      { id: siblingId, depth: 0, children: 0, expanded: false },
      { id: parentId, depth: 0, children: 2, expanded: true },
      { id: subagentOneId, depth: 1, children: 1, expanded: true },
      { id: grandchildId, depth: 2, children: 0, expanded: false },
      { id: subagentTwoId, depth: 1, children: 0, expanded: false },
    ]);
  });

  it("leaves a parent collapsed when the parent itself is the open thread", () => {
    const list = buildList(makeProjectThreads(), { activeThreadKey: threadKey(parentId) });

    expect(rowShapes(list)).toEqual([
      { id: siblingId, depth: 0, children: 0, expanded: false },
      { id: parentId, depth: 0, children: 2, expanded: false },
    ]);
  });

  it("renders orphan subagents as flat top-level rows", () => {
    const missingParentId = ThreadId.make("thread-missing-parent");
    const archivedParentId = ThreadId.make("thread-archived-parent");
    const threads = [
      makeListThread({ id: parentId, latestUserMessageAt: "2026-01-03T00:00:00.000Z" }),
      makeListThread({
        id: ThreadId.make("thread-orphan"),
        latestUserMessageAt: "2026-01-02T00:00:00.000Z",
        lineage: subagentLineage(missingParentId, missingParentId),
      }),
      makeListThread({
        id: ThreadId.make("thread-archived-parent"),
        latestUserMessageAt: "2026-01-05T00:00:00.000Z",
        archivedAt: "2026-01-06T00:00:00.000Z",
      }),
      makeListThread({
        id: ThreadId.make("thread-orphan-of-archived"),
        latestUserMessageAt: "2026-01-04T00:00:00.000Z",
        lineage: subagentLineage(archivedParentId, archivedParentId),
      }),
    ];

    const list = buildList(threads);

    expect(rowShapes(list)).toEqual([
      { id: "thread-orphan-of-archived", depth: 0, children: 0, expanded: false },
      { id: parentId, depth: 0, children: 0, expanded: false },
      { id: "thread-orphan", depth: 0, children: 0, expanded: false },
    ]);
    expect(list.visibleThreads.map((thread) => thread.id)).not.toContain(archivedParentId);
  });

  it("keeps fork threads top-level", () => {
    const threads = [
      makeListThread({ id: parentId, latestUserMessageAt: "2026-01-03T00:00:00.000Z" }),
      makeListThread({
        id: ThreadId.make("thread-fork"),
        latestUserMessageAt: "2026-01-04T00:00:00.000Z",
        lineage: {
          rootThreadId: parentId,
          parentThreadId: parentId,
          relationshipToParent: "fork",
        },
      }),
    ];

    const list = buildList(threads, {
      expandedSubagentParentKeys: new Set([threadKey(parentId)]),
    });

    expect(rowShapes(list)).toEqual([
      { id: "thread-fork", depth: 0, children: 0, expanded: false },
      { id: parentId, depth: 0, children: 0, expanded: false },
    ]);
  });

  it("renders only the open thread, flat, while its project is collapsed", () => {
    const list = buildList(makeProjectThreads(), {
      projectExpanded: false,
      activeThreadKey: threadKey(subagentOneId),
      expandedSubagentParentKeys: new Set([threadKey(parentId)]),
    });

    expect(rowShapes(list)).toEqual([
      { id: subagentOneId, depth: 0, children: 0, expanded: false },
    ]);
    expect(list.pinnedCollapsedThread?.id).toBe(subagentOneId);
  });

  it("returns no rows for a collapsed project without the open thread", () => {
    const list = buildList(makeProjectThreads(), { projectExpanded: false });

    expect(list.rows).toEqual([]);
    expect(list.pinnedCollapsedThread).toBeNull();
  });

  it("previews top-level rows only; nested children ride with their parent", () => {
    const extraTopLevelId = ThreadId.make("thread-extra");
    const threads = [
      ...makeProjectThreads(),
      makeListThread({
        id: extraTopLevelId,
        latestUserMessageAt: "2026-01-06T00:00:00.000Z",
      }),
    ];

    const previewList = buildList(threads, { previewCount: 2 });
    expect(rowShapes(previewList)).toEqual([
      { id: extraTopLevelId, depth: 0, children: 0, expanded: false },
      { id: siblingId, depth: 0, children: 0, expanded: false },
    ]);
    expect(previewList.hiddenTopLevelThreads.map((thread) => thread.id)).toEqual([parentId]);

    const expandedList = buildList(threads, {
      previewCount: 2,
      expandedSubagentParentKeys: new Set([threadKey(parentId)]),
    });
    expect(rowShapes(expandedList)).toEqual([
      { id: extraTopLevelId, depth: 0, children: 0, expanded: false },
      { id: siblingId, depth: 0, children: 0, expanded: false },
    ]);
    expect(expandedList.hiddenTopLevelThreads.map((thread) => thread.id)).toEqual([parentId]);
  });

  it("lists every top-level thread once the list is expanded", () => {
    const threads = [
      makeListThread({ id: parentId, latestUserMessageAt: "2026-01-03T00:00:00.000Z" }),
      makeListThread({
        id: subagentOneId,
        latestUserMessageAt: "2026-01-02T00:00:00.000Z",
        lineage: subagentLineage(parentId, parentId),
      }),
      makeListThread({
        id: ThreadId.make("thread-late"),
        latestUserMessageAt: "2026-01-01T00:00:00.000Z",
      }),
    ];

    const list = buildList(threads, { previewCount: 1, listExpanded: true });

    expect(rowShapes(list)).toEqual([
      { id: parentId, depth: 0, children: 1, expanded: false },
      { id: "thread-late", depth: 0, children: 0, expanded: false },
    ]);
    expect(list.hiddenTopLevelThreads).toEqual([]);
  });

  it("does not nest a subagent whose parent lives in another environment", () => {
    const threads = [
      makeListThread({ id: parentId, latestUserMessageAt: "2026-01-03T00:00:00.000Z" }),
      makeListThread({
        id: ThreadId.make("thread-remote-child"),
        environmentId: EnvironmentId.make("environment-other"),
        latestUserMessageAt: "2026-01-02T00:00:00.000Z",
        lineage: subagentLineage(parentId, parentId),
      }),
    ];

    const list = buildList(threads);

    expect(rowShapes(list)).toEqual([
      { id: parentId, depth: 0, children: 0, expanded: false },
      { id: "thread-remote-child", depth: 0, children: 0, expanded: false },
    ]);
  });

  it("ignores self-referential lineage instead of nesting", () => {
    const selfParentId = ThreadId.make("thread-self-parent");
    const threads = [
      makeListThread({ id: parentId, latestUserMessageAt: "2026-01-03T00:00:00.000Z" }),
      makeListThread({
        id: selfParentId,
        latestUserMessageAt: "2026-01-02T00:00:00.000Z",
        lineage: subagentLineage(selfParentId, selfParentId),
      }),
    ];

    const list = buildList(threads);

    expect(rowShapes(list)).toEqual([
      { id: parentId, depth: 0, children: 0, expanded: false },
      { id: selfParentId, depth: 0, children: 0, expanded: false },
    ]);
  });
});

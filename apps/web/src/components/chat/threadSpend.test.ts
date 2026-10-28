import { describe, expect, it } from "@effect/vitest";

import type { UsageSessionSpend } from "@t3tools/contracts";

import {
  buildProjectSpendView,
  buildThreadSpendView,
  descendantSubagentIds,
  formatSpendLabel,
  joinableSessionRef,
  sessionListKey,
  spendResultIncomplete,
  type SpendThreadNode,
} from "./threadSpend.ts";

function node(overrides: Partial<SpendThreadNode> & Pick<SpendThreadNode, "id">): SpendThreadNode {
  return {
    title: overrides.id,
    environmentId: "env-1",
    deleted: false,
    relationshipToParent: null,
    parentThreadId: null,
    activeProviderThreadId: "provider-thread",
    sessions: [],
    ...overrides,
  };
}

function priced(
  sessionId: string,
  costUsd: number,
  tokens: number,
  unpricedRecords = 0,
): UsageSessionSpend {
  return {
    provider: "codex",
    sessionId,
    totals: {
      uncachedInputTokens: tokens,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd,
    costSource: unpricedRecords > 0 ? "unpriced" : "modelPriced",
    records: 1,
    unpricedRecords,
  };
}

describe("joinableSessionRef", () => {
  it("joins known native ids and skips ids that are not usage sessions", () => {
    expect(joinableSessionRef("codex", "session-1")).toEqual({
      provider: "codex",
      sessionId: "session-1",
    });
    expect(joinableSessionRef("claudeAgent", "parent:task:task-1")).toBeNull();
    expect(joinableSessionRef("cursor", "conversation-1")).toBeNull();
    expect(joinableSessionRef("antigravity", "conversation-1")).toBeNull();
    expect(joinableSessionRef("pi", "C:\\sessions\\pi.jsonl")).toBeNull();
    expect(joinableSessionRef("pi", "session-from-file")).toEqual({
      provider: "pi",
      sessionId: "session-from-file",
    });
    expect(joinableSessionRef("codex", "session-1", "weak")).toBeNull();
    expect(joinableSessionRef("codex", "session-1", "none")).toBeNull();
  });
});

describe("buildThreadSpendView", () => {
  const parent = node({
    id: "parent",
    title: "Parent",
    sessions: [{ provider: "codex", sessionId: "parent-session" }],
  });
  const child = node({
    id: "child",
    title: "Audit",
    relationshipToParent: "subagent",
    parentThreadId: "parent",
    sessions: [{ provider: "codex", sessionId: "child-session" }],
  });
  const fork = node({
    id: "fork",
    relationshipToParent: "fork",
    parentThreadId: "parent",
    sessions: [{ provider: "codex", sessionId: "fork-session" }],
  });
  const unsplit = node({
    id: "native-child",
    title: "Native child",
    relationshipToParent: "subagent",
    parentThreadId: "parent",
    activeProviderThreadId: null,
    sessions: [],
  });

  it("keeps forks out and adds a loaded subagent once", () => {
    expect(new Set(descendantSubagentIds("parent", [parent, child, fork, unsplit]))).toEqual(
      new Set(["child", "native-child"]),
    );
    const view = buildThreadSpendView({
      thread: parent,
      threads: [parent, child, fork],
      priced: [priced("parent-session", 1.5, 1000), priced("child-session", 0.5, 400)],
      refreshing: false,
      partial: false,
      sinceDay: "2026-07-01",
      untilDay: "2026-08-07",
    });
    expect(view).toMatchObject({
      kind: "ready",
      own: { costUsd: 1.5, tokens: 1000 },
      includingSubagents: { costUsd: 2, tokens: 1400 },
      subagentsNotIncluded: false,
    });
  });

  it("does not treat an unjoined provider thread as zero spend", () => {
    const hidden = node({
      id: "child",
      relationshipToParent: "subagent",
      parentThreadId: "parent",
      activeProviderThreadId: "provider-thread",
      sessions: [],
    });
    const view = buildThreadSpendView({
      thread: parent,
      threads: [parent, hidden],
      priced: [priced("parent-session", 1.5, 1000)],
      refreshing: false,
      partial: false,
      sinceDay: null,
      untilDay: null,
    });
    expect(view).toMatchObject({
      kind: "ready",
      own: { costUsd: 1.5, tokens: 1000 },
      includingSubagents: null,
      subagentsNotIncluded: true,
    });
  });

  it("does not invent $0 when a subagent session is not loaded", () => {
    const unloadedChild = node({
      id: "child",
      relationshipToParent: "subagent",
      parentThreadId: "parent",
      sessions: null,
    });
    const view = buildThreadSpendView({
      thread: parent,
      threads: [parent, unloadedChild],
      priced: [priced("parent-session", 1.5, 1000)],
      refreshing: false,
      partial: false,
      sinceDay: null,
      untilDay: null,
    });
    expect(view).toMatchObject({
      kind: "ready",
      includingSubagents: null,
      subagentsNotIncluded: true,
    });
  });

  it("says an unsplit native subagent is inside the parent", () => {
    const view = buildThreadSpendView({
      thread: unsplit,
      threads: [parent, unsplit],
      priced: [],
      refreshing: false,
      partial: false,
      sinceDay: null,
      untilDay: null,
    });
    expect(view).toEqual({ kind: "unsplit", parentTitle: "Parent" });
  });

  it("says there is no usage when the session has no priced records", () => {
    const view = buildThreadSpendView({
      thread: parent,
      threads: [parent],
      priced: [],
      refreshing: false,
      partial: false,
      sinceDay: null,
      untilDay: null,
    });
    expect(view).toEqual({ kind: "empty", partial: false, refreshing: false });
  });

  it("carries scan state on an empty read so it cannot read as settled", () => {
    const view = buildThreadSpendView({
      thread: parent,
      threads: [parent],
      priced: [],
      refreshing: true,
      partial: true,
      sinceDay: null,
      untilDay: null,
    });
    expect(view).toEqual({ kind: "empty", partial: true, refreshing: true });
  });

  it("keeps a priced zero", () => {
    const view = buildThreadSpendView({
      thread: parent,
      threads: [parent],
      priced: [priced("parent-session", 0, 10)],
      refreshing: true,
      partial: true,
      sinceDay: "2026-07-01",
      untilDay: "2026-08-07",
    });
    expect(view).toMatchObject({
      kind: "ready",
      own: { costUsd: 0, tokens: 10, unpriced: false },
      refreshing: true,
      partial: true,
    });
  });
});

describe("buildProjectSpendView", () => {
  it("counts a session once when the read repeats a row", () => {
    const view = buildProjectSpendView({
      priced: [priced("shared", 3, 90), { ...priced("shared", 3, 90) }],
      threads: 2,
      partial: false,
      refreshing: false,
      sinceDay: "2026-07-01",
      untilDay: "2026-08-07",
    });
    expect(view).toMatchObject({
      kind: "ready",
      money: { costUsd: 3, tokens: 90 },
      threads: 2,
      partial: false,
    });
  });

  it("stays empty instead of zero when nothing has been priced", () => {
    const view = buildProjectSpendView({
      priced: [],
      threads: 3,
      partial: true,
      refreshing: false,
      sinceDay: null,
      untilDay: null,
    });
    expect(view).toEqual({ kind: "empty", partial: true, refreshing: false });
  });

  it("carries scan state on an empty project read", () => {
    const view = buildProjectSpendView({
      priced: [],
      threads: 3,
      partial: false,
      refreshing: true,
      sinceDay: null,
      untilDay: null,
    });
    expect(view).toEqual({ kind: "empty", partial: false, refreshing: true });
  });

  it("stays loading until a read answers", () => {
    expect(
      buildProjectSpendView({
        priced: null,
        threads: 4,
        partial: false,
        refreshing: false,
        sinceDay: null,
        untilDay: null,
      }),
    ).toEqual({ kind: "loading" });
  });
});

describe("formatSpendLabel", () => {
  const money = {
    tokens: 1_500_000,
    costUsd: 2.5,
    unpriced: false,
    unpricedRecords: 0,
    category: null,
  };

  it("shows dollars and tokens", () => {
    expect(formatSpendLabel(money, false)).toBe("$2.50 · 1.50M");
  });

  it("marks totals that can only be a lower bound", () => {
    expect(formatSpendLabel({ ...money, unpricedRecords: 2 }, false)).toBe("≥ $2.50 · 1.50M");
    expect(formatSpendLabel(money, true)).toBe("≥ $2.50 · 1.50M");
  });

  it("keeps the token total when nothing could be priced", () => {
    expect(formatSpendLabel({ ...money, unpriced: true, unpricedRecords: 4 }, true)).toBe(
      "unpriced · 1.50M",
    );
  });
});

describe("spendResultIncomplete", () => {
  it("treats a dropped session, an unresolved thread or a failed source as a lower bound", () => {
    expect(spendResultIncomplete({ incomplete: true })).toBe(true);
    expect(spendResultIncomplete({ truncatedSessions: 1 })).toBe(true);
    expect(spendResultIncomplete({ unresolvedThreads: 2 })).toBe(true);
  });

  it("stays exact for a complete read and for no read at all", () => {
    expect(spendResultIncomplete({ incomplete: false, truncatedSessions: 0 })).toBe(false);
    expect(spendResultIncomplete(null)).toBe(false);
    expect(spendResultIncomplete(undefined)).toBe(false);
  });
});

describe("sessionListKey", () => {
  it("separates a thread with no joinable sessions from one that has not loaded", () => {
    expect(sessionListKey([])).not.toBe(sessionListKey(null));
    expect(sessionListKey(null)).toBe(sessionListKey(undefined));
    expect(sessionListKey([{ provider: "codex", sessionId: "session-1" }])).toBe(
      sessionListKey([{ provider: "codex", sessionId: "session-1" }]),
    );
  });
});

import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "./diffPanelStore";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const api = { key: "/code/api", name: "api", cwd: "/code/api" };

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      repositoryByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });

  it("starts a newly picked repo on the automatic base branch", () => {
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(threadRef, "release");
    store.selectRepository(threadRef, api);

    const state = useDiffPanelStore.getState();
    expect(selectThreadDiffPanelSelection(state.byThreadKey, threadRef)).toEqual({
      kind: "branch",
      baseRef: null,
    });
    expect(Object.values(state.repositoryByThreadKey)).toEqual([api]);

    state.selectRepository(threadRef, null);
    expect(useDiffPanelStore.getState().repositoryByThreadKey).toEqual({});
  });

  it("opens All repos for a turn file from another repo than the one shown", () => {
    const store = useDiffPanelStore.getState();
    const runId = RunId.make("run");
    store.selectRepository(threadRef, api);
    store.selectTurn(threadRef, runId, "src/server.ts", api.key);
    expect(Object.values(useDiffPanelStore.getState().repositoryByThreadKey)).toEqual([api]);

    store.selectTurn(threadRef, runId, "README.md", "home");
    const state = useDiffPanelStore.getState();
    expect(state.repositoryByThreadKey).toEqual({});
    expect(selectThreadDiffPanelSelection(state.byThreadKey, threadRef)).toMatchObject({
      kind: "turn",
      filePath: "README.md",
      repositoryKey: "home",
    });
  });
});

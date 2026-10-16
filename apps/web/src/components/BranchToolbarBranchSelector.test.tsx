// @vitest-environment jsdom

import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  RunId,
  type VcsRef,
} from "@t3tools/contracts";
import { act, createRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  worktreePath: null as string | null,
  updateMetadata: vi.fn().mockResolvedValue({ _tag: "Success" }),
  stopSession: vi.fn().mockResolvedValue({ _tag: "Success" }),
}));
const mainRef: VcsRef = {
  name: "main",
  isDefault: true,
  isRemote: false,
  current: false,
  worktreePath: "/repo",
};
const serverThread = () => ({
  id: ThreadId.make("thread"),
  environmentId: EnvironmentId.make("local"),
  projectId: ProjectId.make("project"),
  branch: "topic",
  worktreePath: state.worktreePath,
  pullRequests: [],
  runtime: {
    status: "running",
    activeRunId: RunId.make("run"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-10-16T00:00:00Z",
  },
});
vi.mock("../state/entities", () => ({
  useQuietThreadShell: () => serverThread(),
  readThreadShell: () => serverThread(),
  useProject: () => ({ id: ProjectId.make("project"), workspaceRoot: "/repo" }),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      getDraftThreadByRef: () => ({
        environmentId: "local",
        projectId: "project",
        branch: "topic",
        worktreePath: "/repo/worktree",
        envMode: "worktree",
      }),
      setDraftThreadContext: vi.fn(),
    }),
}));
vi.mock("../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: { updateMetadata: "update", stopSession: "stop" },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "stop" ? state.stopSession : state.updateMetadata,
}));
vi.mock("../state/vcs", () => ({ vcsEnvironment: { status: vi.fn(), listRefs: vi.fn() } }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { refName: "topic", refs: [mainRef] }, refresh: vi.fn() }),
}));
vi.mock("../state/queries", () => ({
  usePaginatedBranches: () => ({
    refs: [mainRef],
    data: { nextCursor: null, totalCount: 1 },
    isPending: false,
  }),
}));
vi.mock("../hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => false,
}));
vi.mock("../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("./chat/composerEventScope", () => ({ useComposerMenuProps: () => ({}) }));
vi.mock("./chat/ThreadDetailsPrRows", () => ({ ThreadDetailsPrRows: () => null }));
vi.mock("../rightPanelStore", () => ({ useRightPanelStore: { getState: vi.fn() } }));
vi.mock("./ThreadStatusIndicators", () => ({
  ThreadPullRequestBadgeControl: () => null,
  prStatusIndicator: () => null,
  resolveThreadPullRequestBadge: () => null,
  useLinkedThreadPullRequest: () => null,
}));
// jsdom has no layout measurements for the virtualized list.
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    data: string[];
    renderItem: (row: { item: string; index: number }) => ReactNode;
  }) => data.map((item, index) => <div key={item}>{renderItem({ item, index })}</div>),
}));

import {
  BranchToolbarBranchSelector,
  type BranchToolbarBranchSelectorHandle,
} from "./BranchToolbarBranchSelector";

it.each(["toolbar", "panel"] as const)(
  "keeps the main checkout selectable in %s with a running server thread and retained worktree draft",
  async (displayMode) => {
    vi.clearAllMocks();
    state.worktreePath = "/repo/worktree";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<BranchToolbarBranchSelectorHandle>();
    const renderSelector = () =>
      root.render(
        <BranchToolbarBranchSelector
          displayMode={displayMode}
          ref={ref}
          environmentId={EnvironmentId.make("local")}
          threadId={ThreadId.make("thread")}
          envLocked
          startFromOrigin={false}
          onStartFromOriginChange={vi.fn()}
        />,
      );
    try {
      await act(async () => renderSelector());
      await act(async () => ref.current?.open());
      expect(document.querySelector('[role="option"]')?.getAttribute("aria-disabled")).toBe("true");
      expect(document.body.textContent).toContain("Stop the current turn to switch worktrees.");
      state.worktreePath = null;
      await act(async () => renderSelector());
      const main = document.querySelector<HTMLElement>('[role="option"]');
      expect(main?.textContent).toContain("main");
      expect(main?.getAttribute("aria-disabled")).not.toBe("true");
      expect(document.body.textContent).not.toContain("Stop the current turn to switch worktrees.");
      await act(async () => main?.click());
      expect(state.updateMetadata).toHaveBeenCalledWith({
        environmentId: "local",
        input: { threadId: "thread", branch: "main", worktreePath: null },
      });
      expect(state.stopSession).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      state.worktreePath = null;
      vi.unstubAllGlobals();
    }
  },
);

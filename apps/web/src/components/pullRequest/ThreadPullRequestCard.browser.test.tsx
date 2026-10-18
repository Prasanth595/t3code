import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  SourceControlProviderKind,
  type PullRequestDetail,
  type GitHistoryResult,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "~/index.css";

const state = vi.hoisted(() => ({
  detail: null as PullRequestDetail | null,
  history: null as GitHistoryResult | null,
  status: null as object | null,
  canWrite: true,
  supported: true,
  historySupported: true,
  pending: false,
  error: null as string | null,
  historyError: null as string | null,
  stack: null as object | null,
  perform: vi.fn(),
  handoff: vi.fn(),
  open: vi.fn(),
  refresh: vi.fn(),
  resolve: null as ((detail: PullRequestDetail) => unknown) | null,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.canWrite) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map([
      [
        "environment",
        {
          environment: {
            capabilities: { pullRequests: state.supported, gitHistory: state.historySupported },
          },
        },
      ],
    ])) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => ({
  ...(await original()),
  pullRequestEnvironment: {
    detail: () => "detail",
    runAction: { permissionAtom: () => null },
  } as never,
  pullRequestStackAtom: (() => "stack") as never,
}));
vi.mock(import("~/state/git"), async (original) => ({
  ...(await original()),
  gitEnvironment: { history: () => "history" } as never,
}));
vi.mock(import("~/state/vcs"), async (original) => ({
  ...(await original()),
  vcsEnvironment: { status: () => "status" } as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((query: string | null) => ({
    data:
      query === "detail"
        ? state.detail
        : query === "history"
          ? state.history
          : query === "stack"
            ? state.stack
            : query === "status"
              ? state.status
              : null,
    error: query === "detail" ? state.error : query === "history" ? state.historyError : null,
    isPending: query === "detail" && state.pending,
    refresh: state.refresh,
  })) as never,
}));
vi.mock(import("~/rightPanelStore"), async (original) => ({
  ...(await original()),
  useRightPanelStore: { getState: () => ({ openPullRequest: state.open }) } as never,
}));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("~/hooks/usePullRequestChecksRefresh", () => ({ usePullRequestChecksRefresh: () => {} }));
vi.mock("./usePullRequestActions", () => ({
  usePullRequestDefaultMergeMethodResolver: () => () => undefined,
  usePullRequestHandoffs: () => ({ handoff: null, startHandoff: state.handoff }),
  usePullRequestActionRunner: (input: {
    resolveMergeMethod: (detail: PullRequestDetail) => unknown;
  }) => {
    state.resolve = input.resolveMergeMethod;
    return { actionPending: false, perform: state.perform };
  },
}));
vi.mock("../RelativeTime", () => ({ RelativeTime: () => "now" }));

import { ThreadPullRequestCard } from "./ThreadPullRequestCard";
import { GitCommitGraph } from "./PullRequestBranchGraph";
import { pullRequestGraphTarget } from "./pullRequestDetail.logic";
import { useUiStateStore } from "~/uiStateStore";

const environmentId = EnvironmentId.make("environment");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
const detail: PullRequestDetail = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 128,
  title: "Refresh sessions in the auth middleware",
  body: "",
  url: "https://github.com/owner/repo/pull/128",
  author: null,
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 482,
  deletions: 37,
  changedFiles: 2,
  headBranch: "feat/session-refresh",
  baseBranch: "main",
  createdAt: "2026-10-18T10:00:00Z",
  updatedAt: "2026-10-18T10:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: { merge: true, squash: true, rebase: false },
  capabilities: {
    diff: true,
    comment: true,
    search: true,
    actions: ["merge"],
    mergeMethods: ["merge", "squash"],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  viewerPermissions: {
    actions: ["merge"],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};
let root: Root;
let container: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(
      <ThreadPullRequestCard threadRef={threadRef} link={{ ...detail }} cwd="/workspace" />,
    ),
  );
const renderHistory = (props: Partial<Parameters<typeof GitCommitGraph>[0]> = {}) =>
  act(async () =>
    root.render(
      <GitCommitGraph
        history={state.history!}
        headBranch={detail.headBranch}
        baseBranch={detail.baseBranch}
        {...props}
      />,
    ),
  );
const settle = (element: Element) =>
  Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
const withCommit = (sha: string, subject: string) => ({
  ...state.history!,
  headSha: sha,
  commits: [
    { ...state.history!.commits[0]!, sha, parents: [state.history!.headSha!], subject },
    ...state.history!.commits,
  ],
});
const vcsStatus = (overrides: { aheadCount?: number; files?: number } = {}) => ({
  refName: detail.headBranch,
  aheadCount: overrides.aheadCount ?? 0,
  behindCount: 0,
  hasWorkingTreeChanges: (overrides.files ?? 0) > 0,
  workingTree: {
    files: Array.from({ length: overrides.files ?? 0 }, (_, index) => ({
      path: `file-${index}.ts`,
      insertions: 1,
      deletions: 0,
    })),
    insertions: 0,
    deletions: 0,
  },
});
const ready = pullRequestGraphTarget(detail, false);
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.detail = detail;
  state.history = {
    commits: Array.from({ length: 10 }, (_, index) => ({
      sha: `sha-${index}`,
      parents: index === 9 ? [] : [`sha-${index + 1}`],
      subject: `Commit ${index}`,
      author: "You",
      authoredAt: "2026-10-18T10:00:00Z",
      branches: [],
    })),
    headSha: "sha-0",
    baseSha: "sha-9",
    truncated: false,
  };
  state.canWrite = true;
  state.supported = true;
  state.historySupported = true;
  state.pending = false;
  state.error = null;
  state.historyError = null;
  state.stack = null;
  state.status = null;
  state.perform.mockReset();
  state.handoff.mockReset();
  state.open.mockReset();
  state.refresh.mockReset();
  useUiStateStore.getState().setPullRequestMergeMethod("squash");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("expands history and collapses the card without navigating", async () => {
  await render();
  await expect.element(page.getByText("Commit 0", { exact: true })).toBeVisible();
  expect(container.textContent).not.toContain("Commit 9");
  await page.getByRole("button", { name: "Show 2 more commits" }).click();
  await expect.element(page.getByText("Commit 9", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Collapse pull request" }).click();
  await expect
    .poll(() => container.querySelector('[aria-label="Branch commit history"]'))
    .toBeNull();
  expect(state.open).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Expand pull request" }).click();
  await expect.element(page.getByText("Commit 0", { exact: true })).toBeVisible();
});
it("keeps existing commits in place during a refreshed history and settles without idle animation", async () => {
  await renderHistory();
  const row = container.querySelector<HTMLElement>('[data-commit-sha="sha-0"]')!;
  await Promise.all(row.getAnimations().map((animation) => animation.finished));
  state.history = {
    ...state.history!,
    headSha: "new-head",
    commits: [
      { ...state.history!.commits[0]!, sha: "new-head", parents: ["sha-0"], subject: "New commit" },
      ...state.history!.commits,
    ],
  };
  await renderHistory();
  expect(container.querySelector('[data-commit-sha="sha-0"]')).toBe(row);
  expect(
    row
      .getAnimations()
      .some((animation) =>
        (animation.effect as KeyframeEffect)
          .getKeyframes()
          .some((frame) => frame.transform === "translateY(-32px)"),
      ),
  ).toBe(true);
  await Promise.all(row.getAnimations().map((animation) => animation.finished));
  expect(row.getAnimations()).toHaveLength(0);
  await expect.element(page.getByText("New commit", { exact: true })).toBeVisible();
});
it("does not move existing commits when reduced motion is requested", async () => {
  const matchMedia = window.matchMedia.bind(window);
  const reducedMotion = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) =>
      query === "(prefers-reduced-motion: reduce)"
        ? ({ ...matchMedia(query), matches: true } as MediaQueryList)
        : matchMedia(query),
    );
  try {
    await renderHistory();
    const row = container.querySelector<HTMLElement>('[data-commit-sha="sha-0"]')!;
    await Promise.all(row.getAnimations().map((animation) => animation.finished));
    state.history = {
      ...state.history!,
      commits: [
        {
          ...state.history!.commits[0]!,
          sha: "new-head",
          parents: ["sha-0"],
          subject: "New commit",
        },
        ...state.history!.commits,
      ],
    };
    await renderHistory();
    expect(row.getAnimations()).toHaveLength(0);
    await expect.element(page.getByText("New commit", { exact: true })).toBeVisible();
  } finally {
    reducedMotion.mockRestore();
  }
});
it("updates to an agent-merged PR without remounting its graph or leaving a merge action", async () => {
  await render();
  const graph = container.querySelector('[aria-label="Branch commit history"]');
  state.detail = { ...detail, state: "merged", mergedAt: "2026-10-18T11:00:00Z" };
  await render();
  await expect.element(page.getByText("Pull request merged", { exact: true })).toBeVisible();
  expect(container.querySelector('[aria-label="Branch commit history"]')).toBe(graph);
  expect(page.getByRole("button", { name: "Merge", exact: true }).elements()).toHaveLength(0);
});
it("requires a second merge click and rechecks fresh detail with the selected method", async () => {
  await render();
  await page.getByRole("button", { name: "Merge", exact: true }).click();
  expect(state.perform).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Confirm merge?", exact: true }).click();
  expect(state.perform).toHaveBeenCalledExactlyOnceWith("merge");
  expect(state.resolve?.(detail)).toBe("squash");
  expect(() => state.resolve?.({ ...detail, state: "merged" })).toThrow();
  expect(() => state.resolve?.({ ...detail, mergeability: "conflicting" })).toThrow();
  expect(() => state.resolve?.({ ...detail, mergeability: "unknown" })).toThrow();
  expect(() =>
    state.resolve?.({
      ...detail,
      checks: [{ name: "Tests", status: "pending", description: null, url: null }],
    }),
  ).toThrow();
});
it.each(["pending", "failure"] as const)(
  "does not offer merge while checks are %s",
  async (status) => {
    state.detail = { ...detail, checks: [{ name: "Tests", status, description: null, url: null }] };
    await render();
    expect(page.getByRole("button", { name: "Merge", exact: true }).elements()).toHaveLength(0);
  },
);
it("honors read-only access and in-flight refreshes", async () => {
  state.canWrite = false;
  await render();
  await expect.element(page.getByRole("button", { name: "Merge", exact: true })).toBeDisabled();
  state.canWrite = true;
  state.pending = true;
  await render();
  await expect.element(page.getByRole("button", { name: "Merge", exact: true })).toBeDisabled();
});
it("sends conflicts through the existing agent handoff with the PR and both branches", async () => {
  state.detail = { ...detail, mergeability: "conflicting" };
  await render();
  await page.getByRole("button", { name: "Resolve conflicts" }).click();
  expect(state.handoff).toHaveBeenCalledWith("conflicts", {
    prompt: expect.stringContaining(detail.url),
  });
  expect(state.handoff.mock.calls[0]?.[1].prompt).toContain(detail.headBranch);
  expect(state.handoff.mock.calls[0]?.[1].prompt).toContain(detail.baseBranch);
});
it("opens native stacks in the existing detail flow", async () => {
  state.detail = { ...detail, capabilities: { ...detail.capabilities, stackActions: true } };
  state.stack = {};
  await render();
  await page.getByRole("button", { name: "Open stack" }).click();
  expect(state.open).toHaveBeenCalledWith(
    threadRef,
    expect.objectContaining({ number: 128, url: detail.url }),
  );
  expect(state.perform).not.toHaveBeenCalled();
});
it("explains missing local branches", async () => {
  state.history = { commits: [], headSha: null, baseSha: null, truncated: false };
  await render();
  await expect
    .element(page.getByText("Check out this branch to see its commit history."))
    .toBeVisible();
});
it("offers retry after a history read error", async () => {
  state.historyError = "Environment disconnected";
  await render();
  await page.getByRole("button", { name: "Try again" }).click();
  expect(state.refresh).toHaveBeenCalled();
});
it("explains older environments without sending an unsupported history request", async () => {
  state.historySupported = false;
  await render();
  await expect
    .element(page.getByText("Update this environment to see its branch history."))
    .toBeVisible();
});
it("hides the card when the environment cannot read pull requests", async () => {
  state.supported = false;
  await render();
  expect(container.textContent).toBe("");
});
it("shows terminal PR states and never offers merge again", async () => {
  state.detail = {
    ...detail,
    state: "merged",
    capabilities: { ...detail.capabilities, stackActions: true },
  };
  state.stack = {};
  await render();
  await expect.element(page.getByText("Pull request merged", { exact: true })).toBeVisible();
  expect(page.getByRole("button", { name: "Merge", exact: true }).elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "Open stack", exact: true }).elements()).toHaveLength(0);
});
it("decodes the commit that replaces the uncommitted row in place", async () => {
  await renderHistory({ target: ready, workingFiles: 3 });
  const list = container.querySelector<HTMLElement>('[aria-label="Branch commit history"]')!;
  await settle(list);
  await expect.element(page.getByText("Uncommitted changes", { exact: true })).toBeVisible();
  expect(container.textContent).toContain("3 files");
  const previousHead = container.querySelector<HTMLElement>('[data-commit-sha="sha-0"]')!;
  state.history = withCommit("new-head", "Add session refresh tests");
  await renderHistory({ target: ready, workingFiles: null });
  const row = list.children[1] as HTMLElement;
  expect(row.dataset.commitSha).toBe("new-head");
  expect(row.textContent).not.toContain("Add session refresh tests");
  expect(previousHead.getAnimations()).toHaveLength(0);
  await expect.element(page.getByText("Add session refresh tests", { exact: true })).toBeVisible();
  expect(container.textContent).not.toContain("Uncommitted changes");
  await settle(list);
  expect(list.getAnimations({ subtree: true })).toHaveLength(0);
});
it("builds upward from the oldest commit shown, then adds the rows above, once per session", async () => {
  await renderHistory({ target: ready, workingFiles: 2, entranceKey: "build-once" });
  const list = container.querySelector<HTMLElement>('[aria-label="Branch commit history"]')!;
  const lineStart = (sha: string) =>
    Math.min(
      ...[...list.querySelectorAll(`[data-graph-row="${sha}"] path`)].flatMap((path) =>
        path.getAnimations().map((animation) => Number(animation.effect!.getTiming().delay)),
      ),
    );
  const starts = ["sha-7", "sha-3", "sha-0", "working-tree", "pull-request"].map(lineStart);
  expect(starts[0]).toBe(0);
  expect(starts).toEqual(starts.toSorted((a, b) => a - b));
  expect(new Set(starts).size).toBe(starts.length);
  const held = list
    .querySelector('[data-commit-sha="sha-0"]')!
    .getAnimations()
    .flatMap((animation) => (animation.effect as KeyframeEffect).getKeyframes());
  expect(held.some((frame) => frame.transform === "translateY(-64px)")).toBe(true);
  await settle(list);
  await page.getByRole("button", { name: "Show 2 more commits" }).click();
  const head = list.querySelector('[data-commit-sha="sha-0"]')!;
  const target = list.querySelector('[data-graph-row="pull-request"]')!;
  expect(head.getAnimations({ subtree: true })).toHaveLength(0);
  expect(target.getAnimations({ subtree: true })).toHaveLength(0);
  expect(target.textContent).toContain("Merge into main");
  await settle(list);
  await page.getByRole("button", { name: "Show less" }).click();
  expect(head.getAnimations({ subtree: true })).toHaveLength(0);
  expect(target.getAnimations({ subtree: true })).toHaveLength(0);
  await renderHistory({
    target: { ...ready!, tone: "warning", status: "checks 0/1" },
    workingFiles: 2,
    entranceKey: "build-once",
  });
  expect(head.querySelector("path")!.getAnimations()).toHaveLength(0);
  expect(head.getAnimations()).toHaveLength(0);
  expect(target.querySelector("path")!.getAnimations()).toHaveLength(0);
  await act(async () => root.unmount());
  root = createRoot(container);
  await renderHistory({ target: ready, workingFiles: 2, entranceKey: "build-once" });
  const again = container.querySelector<HTMLElement>('[aria-label="Branch commit history"]')!;
  expect(
    again
      .getAnimations({ subtree: true })
      .filter((animation) => !(animation instanceof CSSTransition)),
  ).toHaveLength(0);
});
it("draws an arriving commit into the graph and then stops animating", async () => {
  await renderHistory();
  const list = container.querySelector<HTMLElement>('[aria-label="Branch commit history"]')!;
  await settle(list);
  state.history = withCommit("new-head", "New commit");
  await renderHistory();
  const row = container.querySelector<HTMLElement>('[data-commit-sha="new-head"]')!;
  const keyframes = row
    .getAnimations({ subtree: true })
    .flatMap((animation) => (animation.effect as KeyframeEffect).getKeyframes());
  expect(keyframes.some((frame) => frame.opacity === "0")).toBe(true);
  expect(keyframes.some((frame) => frame.strokeDashoffset === "-1")).toBe(true);
  await settle(list);
  expect(list.getAnimations({ subtree: true })).toHaveLength(0);
  expect(row.textContent).toContain("New commit");
});
it("carries a merge down the branch's own commits, newest first", async () => {
  state.history = {
    ...state.history!,
    commits: state.history!.commits.map((commit, index) =>
      index === 2 ? { ...commit, parents: ["sha-3", "main-tip"] } : commit,
    ),
  };
  await renderHistory({ target: ready });
  const list = container.querySelector<HTMLElement>('[aria-label="Branch commit history"]')!;
  await settle(list);
  await renderHistory({ target: pullRequestGraphTarget({ ...detail, state: "merged" }, false) });
  const delays = ["pull-request", "sha-0", "sha-1"].map((sha) =>
    list
      .querySelector(`[data-graph-row="${sha}"]`)!
      .getAnimations()
      .map((animation) => Number(animation.effect!.getTiming().delay)),
  );
  expect(delays).toEqual([[0], [70], [140]]);
  await expect.element(page.getByText("Merged into main", { exact: true })).toBeVisible();
  await settle(list);
});
it("leaves commits added after the merge out of it", async () => {
  state.history = {
    ...state.history!,
    commits: state.history!.commits.map((commit, index) => ({
      ...commit,
      authoredAt: index === 0 ? "2026-10-18T12:00:00Z" : commit.authoredAt,
      parents: index === 2 ? ["sha-3", "main-tip"] : commit.parents,
    })),
  };
  await renderHistory({ target: ready });
  const list = container.querySelector<HTMLElement>('[aria-label="Branch commit history"]')!;
  await settle(list);
  const merged = { ...detail, state: "merged", mergedAt: "2026-10-18T11:00:00Z" } as const;
  await renderHistory({ target: pullRequestGraphTarget(merged, false) });
  const flashed = ["sha-0", "sha-1"].map(
    (sha) => list.querySelector(`[data-graph-row="${sha}"]`)!.getAnimations().length,
  );
  expect(flashed).toEqual([0, 1]);
  await settle(list);
});
it("follows the checkout live and keeps the uncommitted row until its commit arrives", async () => {
  state.status = vcsStatus({ files: 2 });
  await render();
  await expect.element(page.getByText("Uncommitted changes", { exact: true })).toBeVisible();
  expect(state.refresh).not.toHaveBeenCalled();
  // The mocked queries are not reactive, so a new detail stands in for the status update.
  state.status = vcsStatus({ aheadCount: 1 });
  state.detail = { ...detail };
  await render();
  expect(state.refresh).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Uncommitted changes");
  state.history = withCommit("new-head", "Add session refresh tests");
  state.detail = { ...detail };
  await render();
  await expect.element(page.getByText("Add session refresh tests", { exact: true })).toBeVisible();
  expect(container.textContent).not.toContain("Uncommitted changes");
});
it("shows the pull request's own row with what blocks it", async () => {
  state.detail = { ...detail, mergeability: "conflicting" };
  await render();
  await expect.element(page.getByText("Merge into main", { exact: true })).toBeVisible();
  await expect.element(page.getByText("conflicts", { exact: true })).toBeVisible();
});
it("shows new history without motion when reduced motion is requested", async () => {
  const matchMedia = window.matchMedia.bind(window);
  const reducedMotion = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) =>
      query === "(prefers-reduced-motion: reduce)"
        ? ({ ...matchMedia(query), matches: true } as MediaQueryList)
        : matchMedia(query),
    );
  try {
    await renderHistory({ target: ready, workingFiles: 1, entranceKey: "reduced" });
    state.history = withCommit("new-head", "Add session refresh tests");
    await renderHistory({ target: pullRequestGraphTarget({ ...detail, state: "merged" }, false) });
    const list = container.querySelector<HTMLElement>('[aria-label="Branch commit history"]')!;
    // CSS transitions follow the real media query, which this spy cannot change.
    expect(
      list
        .getAnimations({ subtree: true })
        .filter((animation) => !(animation instanceof CSSTransition)),
    ).toHaveLength(0);
    expect(list.children[1]?.textContent).toContain("Add session refresh tests");
    expect(list.children[0]?.textContent).toContain("Merged into main");
  } finally {
    reducedMotion.mockRestore();
  }
});

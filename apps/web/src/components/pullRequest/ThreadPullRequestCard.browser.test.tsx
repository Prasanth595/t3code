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
    root.render(<ThreadPullRequestCard threadRef={threadRef} link={detail} cwd="/workspace" />),
  );
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
  expect(container.querySelector('[aria-label="Branch commit history"]')).toBeNull();
  expect(state.open).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Expand pull request" }).click();
  await expect.element(page.getByText("Commit 0", { exact: true })).toBeVisible();
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

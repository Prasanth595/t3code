import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
} from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    failure: null,
    isPending: true,
    isSuccess: false,
    error: null,
    refresh: () => {},
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomRefresh: (() => () => {}) as never,
}));

import PullRequestCodeTab from "./PullRequestCodeTab";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "Original description",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "conflicting",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [{ name: "Unit tests", status: "success", description: null, url: null }],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: true, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

const restoredCommit = {
  oid: "abc123",
  messageHeadline: "Restored commit",
  committedDate: "2026-09-01T00:00:00Z",
};

const onSelectedCommitChange = vi.fn();
const roots: Root[] = [];
let root: Root;

function render(props: Partial<ComponentProps<typeof PullRequestCodeTab>>) {
  return act(async () =>
    root.render(
      <PullRequestCodeTab
        scrollerRef={() => {}}
        environmentId={EnvironmentId.make("env-1")}
        reference={detail}
        detail={detail}
        selectedCommitOid={restoredCommit.oid}
        onSelectedCommitChange={onSelectedCommitChange}
        onRefresh={() => {}}
        {...props}
      />,
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSelectedCommitChange.mockReset();
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  document.body.append(container);
  root = createRoot(container);
  roots.push(root);
});
afterEach(async () => {
  for (const mounted of roots.splice(0)) await act(async () => mounted.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("keeps a restored commit scope while the commit list is still loading", async () => {
  await render({ commitsPending: true });
  expect(onSelectedCommitChange).not.toHaveBeenCalled();

  await render({ commitsPending: false, detail: { ...detail, commits: [restoredCommit] } });
  expect(onSelectedCommitChange).not.toHaveBeenCalled();
});

it("drops a commit scope the loaded commit list no longer has", async () => {
  await render({ commitsPending: true });
  await render({ commitsPending: false });
  expect(onSelectedCommitChange).toHaveBeenCalledWith(null);
});

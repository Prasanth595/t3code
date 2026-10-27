import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pendingDraftBranchNeedsRefs, resolvePendingDraftBranch } from "./pending-new-tasks-model";
import type { ComposerDraft, ComposerDraftWorkspaceSelection } from "./use-composer-drafts";

const projectCwd = "/repo";
const branches = [
  { name: "feature", current: true, isDefault: false },
  { name: "origin/main", current: false, isDefault: true, isRemote: true },
];

function draft(workspaceSelection?: ComposerDraftWorkspaceSelection): ComposerDraft {
  return {
    text: "unsent",
    attachments: [],
    project: {
      environmentId: EnvironmentId.make("env-1"),
      projectId: ProjectId.make("project-1"),
      createdAt: "2026-10-26T00:00:00.000Z",
    },
    ...(workspaceSelection ? { workspaceSelection } : {}),
  };
}

describe("resolvePendingDraftBranch", () => {
  it("shows the default base for a worktree draft that never picked one", () => {
    const worktree = draft({ mode: "worktree", branch: null, worktreePath: null });
    expect(pendingDraftBranchNeedsRefs(worktree)).toBe(true);
    expect(resolvePendingDraftBranch({ draft: worktree, branches, projectCwd })).toBe(
      "origin/main",
    );
  });

  it("shows the current branch for a local draft that follows the checkout", () => {
    const local = draft({
      mode: "local",
      branch: null,
      worktreePath: null,
      followsCurrentCheckout: true,
    });
    expect(resolvePendingDraftBranch({ draft: local, branches, projectCwd })).toBe("feature");
    expect(resolvePendingDraftBranch({ draft: local, branches: [], projectCwd })).toBeNull();
  });

  it("keeps a chosen branch without loading refs", () => {
    const chosen = draft({ mode: "local", branch: "release", worktreePath: null });
    expect(pendingDraftBranchNeedsRefs(chosen)).toBe(false);
    expect(resolvePendingDraftBranch({ draft: chosen, branches, projectCwd })).toBe("release");
  });
});

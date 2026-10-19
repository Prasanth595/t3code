import {
  buildMenuItems as buildMobileMenuItems,
  resolveQuickAction as resolveMobileQuickAction,
} from "@t3tools/client-runtime/state/vcs";
import { resolveThreadGitStatus } from "@t3tools/shared/threadPullRequests";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import type { VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, expect, it } from "vite-plus/test";
import {
  buildMenuItems,
  requiresDefaultBranchConfirmation,
  resolveAutoFeatureBranchName,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("when: ref is clean, ahead, and has an open PR", () => {
  it("resolveQuickAction prefers push", () => {
    const quick = resolveQuickAction(
      status({
        aheadCount: 3,
        pr: {
          number: 13,
          title: "Open PR",
          url: "https://example.com/pr/13",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "run_action", action: "push", label: "Push" });
  });
});

describe("when: ref is clean, up to date, and has no open PR", () => {
  it("enables create PR when synced with upstream but ahead of default, even with local changes", () => {
    const syncedFeature = status({
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 1,
      pr: null,
    });

    const quick = resolveQuickAction(syncedFeature, false);
    assert.deepInclude(quick, {
      label: "Create PR",
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });

    const items = buildMenuItems(syncedFeature, false);
    assert.equal(items.find((item) => item.id === "pr")?.disabled, false);

    const dirtyFeature = { ...syncedFeature, hasWorkingTreeChanges: true };
    assert.equal(
      buildMenuItems(dirtyFeature, false).find((item) => item.id === "pr")?.disabled,
      false,
    );
  });
});

describe("when: ref is behind upstream", () => {
  it("resolveQuickAction returns pull", () => {
    const quick = resolveQuickAction(status({ behindCount: 2 }), false);
    assert.deepInclude(quick, { kind: "run_pull", label: "Pull", disabled: false });
  });
});

describe("when: working tree has local changes", () => {
  it("resolveQuickAction returns commit, push, and create PR", () => {
    const quick = resolveQuickAction(status({ hasWorkingTreeChanges: true }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push_pr",
      label: "Commit, push & PR",
    });
  });
});

describe("when: on default ref without open PR", () => {
  it("resolveQuickAction returns commit and push when local changes exist", () => {
    const quick = resolveQuickAction(
      status({ refName: "main", hasWorkingTreeChanges: true }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
      disabled: false,
    });
  });
});

describe("when: ref has no upstream configured", () => {
  it("resolveQuickAction runs push and create PR when no upstream and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create PR",
      disabled: false,
    });
  });

  it("resolveQuickAction publishes when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
      false,
      false,
    );
    assert.deepEqual(quick, {
      kind: "open_publish",
      label: "Publish repository",
      disabled: false,
    });
  });
});

describe("requiresDefaultBranchConfirmation", () => {
  it("requires confirmation for push actions on default ref", () => {
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isTrue(requiresDefaultBranchConfirmation("push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("create_pr", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push_pr", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit_push", false));
    assert.isFalse(requiresDefaultBranchConfirmation("push", false));
  });
});

describe("resolveThreadBranchUpdate", () => {
  it("returns a branch update when the action created a new branch", () => {
    const update = resolveThreadBranchUpdate({
      action: "commit_push_pr",
      branch: {
        status: "created",
        name: "feature/fix-toast-copy",
      },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: add ref sync",
      },
      push: { status: "pushed", branch: "feature/fix-toast-copy" },
      pr: { status: "skipped_not_requested" },
      toast: {
        title: "Pushed 89abcde to origin/feature/fix-toast-copy",
        cta: { kind: "none" },
      },
    });

    assert.deepEqual(update, {
      branch: "feature/fix-toast-copy",
    });
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("returns a branch update when live git status differs from stored thread metadata", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-ref",
      gitStatus: status({ refName: "effect-atom" }),
    });

    assert.deepEqual(update, {
      branch: "effect-atom",
    });
  });

  it("returns null when git status is detached HEAD but the thread already has a ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ refName: null }),
    });

    assert.equal(update, null);
  });

  it("does not regress a semantic thread ref back to a temporary worktree ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "t3code/github-query-rate-limit",
      gitStatus: status({ refName: "t3code/bda76797" }),
    });

    assert.equal(update, null);
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("increments suffix when the preferred ref name already exists", () => {
    const ref = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(ref, "feature/fix-toast-copy-3");
  });

  it("treats existing ref names as case-insensitive for collision checks", () => {
    const ref = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(ref, "feature/ticket-1-2");
  });
});

describe("linked PR git actions", () => {
  const linked: ThreadPullRequestLink = {
    host: "github.com",
    repository: "team/repo",
    number: 42,
    url: "https://github.com/team/repo/pull/42",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00.000Z",
    stack: null,
    snapshot: {
      state: "open",
      title: "Existing PR",
      headBranch: "feature/test",
      headRepositoryNameWithOwner: "team/repo",
      baseBranch: "main",
      isDraft: true,
      updatedAt: null,
      syncedAt: "2026-01-01T00:00:00.000Z",
    },
  };

  it("updates the linked PR from quick actions and menus, and restores creation after unlinking", () => {
    for (const [candidate, repositoryKey] of [
      [linked, "github.com/team/repo"],
      [
        {
          ...linked,
          snapshot: { ...linked.snapshot!, headRepositoryNameWithOwner: "contributor/repo" },
        },
        "github.com/contributor/repo",
      ],
      [
        {
          ...linked,
          host: "github.example.com",
          url: "https://github.example.com:8443/team/repo/pull/42",
        },
        "github.example.com:8443/team/repo",
      ],
    ] as const) {
      for (const hasWorkingTreeChanges of [true, false]) {
        const original = status({
          hasWorkingTreeChanges,
          aheadCount: 1,
          repositoryKey,
        });
        const resolved = resolveThreadGitStatus(original, [candidate]);
        const action = hasWorkingTreeChanges ? "commit_push" : "push";
        expect.soft(resolveQuickAction(resolved, false).action).toBe(action);
        expect.soft(resolveMobileQuickAction(resolved, false).action).toBe(action);
        expect.soft(resolved?.pr?.url).toBe(candidate.url);
        expect.soft(resolved?.pr?.isDraft).toBe(true);
        expect
          .soft(buildMenuItems(resolved, false).map((item) => item.id))
          .toEqual(["commit", "push"]);
        expect
          .soft(buildMobileMenuItems(resolved, false).find((item) => item.id === "pr")?.kind)
          .toBe("open_pr");

        const unlinked = resolveThreadGitStatus(original, []);
        assert.equal(original.pr, null);
        assert.equal(
          resolveQuickAction(unlinked, false).action,
          hasWorkingTreeChanges ? "commit_push_pr" : "create_pr",
        );
        assert.equal(
          resolveMobileQuickAction(unlinked, false).action,
          hasWorkingTreeChanges ? "commit_push_pr" : "create_pr",
        );
        assert.equal(buildMenuItems(unlinked, false).at(-1)?.dialogAction, "create_pr");
        assert.equal(buildMobileMenuItems(unlinked, false).at(-1)?.dialogAction, "create_pr");
      }
    }
  });

  it("only uses loaded, visible, open links for the checkout repository and branch", () => {
    const original = status({
      hasWorkingTreeChanges: true,
      repositoryKey: "github.com/team/repo",
    });
    for (const candidate of [
      { ...linked, snapshot: { ...linked.snapshot!, state: "closed" as const } },
      { ...linked, snapshot: { ...linked.snapshot!, state: "merged" as const } },
      { ...linked, snapshot: null },
      { ...linked, source: "stack-dismissed" as const },
      { ...linked, snapshot: { ...linked.snapshot!, headBranch: "other" } },
      { ...linked, snapshot: { ...linked.snapshot!, headRepositoryNameWithOwner: "other/repo" } },
      { ...linked, snapshot: { ...linked.snapshot!, headRepositoryNameWithOwner: undefined } },
      { ...linked, snapshot: { ...linked.snapshot!, headRepositoryNameWithOwner: null } },
      { ...linked, url: "https://github.com:8443/team/repo/pull/42" },
      {
        ...linked,
        host: "github.example.com",
        url: "https://github.example.com/team/repo/pull/42",
      },
    ]) {
      expect.soft(resolveThreadGitStatus(original, [candidate])).toBe(original);
    }
    for (const refName of ["feature/test", "main"]) {
      const checkout = status({
        refName,
        isDefaultRef: refName === "main",
        hasWorkingTreeChanges: true,
        repositoryKey: "github.com/team/repo",
      });
      const foreignFork = {
        ...linked,
        snapshot: {
          ...linked.snapshot!,
          headBranch: refName,
          headRepositoryNameWithOwner: "contributor/repo",
        },
      };
      const resolved = resolveThreadGitStatus(checkout, [foreignFork]);
      expect.soft(resolved).toBe(checkout);
      expect
        .soft(resolveQuickAction(resolved, false, checkout.isDefaultRef))
        .toEqual(resolveQuickAction(checkout, false, checkout.isDefaultRef));
      expect
        .soft(resolveMobileQuickAction(resolved, false, checkout.isDefaultRef))
        .toEqual(resolveMobileQuickAction(checkout, false, checkout.isDefaultRef));
      expect.soft(buildMenuItems(resolved, false)).toEqual(buildMenuItems(checkout, false));
      expect
        .soft(buildMobileMenuItems(resolved, false))
        .toEqual(buildMobileMenuItems(checkout, false));
    }
    const portLink = {
      ...linked,
      host: "github.example.com",
      url: "https://github.example.com:8443/team/repo/pull/42",
    };
    for (const repositoryKey of [
      "github.example.com/team/repo",
      "github.example.com:9443/team/repo",
    ]) {
      const checkout = status({ hasWorkingTreeChanges: true, repositoryKey });
      expect.soft(resolveThreadGitStatus(checkout, [portLink])).toBe(checkout);
    }
    for (const repositoryKey of ["github.com/team/unrelated", undefined]) {
      const checkout = status({ hasWorkingTreeChanges: true, repositoryKey });
      const resolved = resolveThreadGitStatus(checkout, [linked]);
      assert.equal(resolved, checkout);
      assert.equal(resolveQuickAction(resolved, false).action, "commit_push_pr");
      assert.equal(resolveMobileQuickAction(resolved, false).action, "commit_push_pr");
    }
  });

  it("keeps authoritative VCS PR results even when a different open PR is linked", () => {
    for (const state of ["open", "closed", "merged"] as const) {
      const pr = {
        number: 99,
        url: "https://github.com/team/repo/pull/99",
        title: "VCS result",
        headRef: "feature/test",
        baseRef: "main",
        state,
      };
      assert.equal(
        resolveThreadGitStatus(status({ pr, repositoryKey: "github.com/team/repo" }), [linked])?.pr,
        pr,
      );
    }
  });
});

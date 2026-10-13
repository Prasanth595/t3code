import { describe, expect, it } from "@effect/vitest";

import {
  branchNameFromMessage,
  expandWorktreePathTemplate,
  validateWorktreePathTemplate,
  worktreePathBranchVariables,
} from "./worktreePathTemplate.ts";

describe("validateWorktreePathTemplate", () => {
  it("accepts templates with a branch variable", () => {
    expect(validateWorktreePathTemplate("{repoDir}/{branchLeaf}")).toBeNull();
    expect(validateWorktreePathTemplate("{worktrees}/{repo}/{branch}")).toBeNull();
  });

  it("rejects unknown variables, unclosed braces and templates without a branch", () => {
    expect(validateWorktreePathTemplate("{repoDir}/{name}")).toContain("{name}");
    expect(validateWorktreePathTemplate("{repoDir}/{branch")).not.toBeNull();
    expect(validateWorktreePathTemplate("{worktrees}/{repo}")).not.toBeNull();
  });
});

describe("expandWorktreePathTemplate", () => {
  it("fills every occurrence of each variable", () => {
    expect(
      expandWorktreePathTemplate("{repoDir}/../{repo}-{branch}/{branchLeaf}", {
        worktrees: "/w",
        repoDir: "/code/foo",
        repo: "foo",
        ...worktreePathBranchVariables("feat/api/qcdi-1234-auth"),
      }),
    ).toBe("/code/foo/../foo-feat-api-qcdi-1234-auth/qcdi-1234-auth");
  });
});

describe("branchNameFromMessage", () => {
  it("names the branch from the first words of the message", () => {
    expect(
      branchNameFromMessage("Fix the sidebar flicker on new threads please, it is bad", {
        mode: "semantic",
        prefix: "t3",
      }),
    ).toBe("fix-the-sidebar-flicker-on-new");
  });

  it("adds the prefix only in the static mode", () => {
    expect(branchNameFromMessage("Fix flicker", { mode: "static", prefix: "yarden" })).toBe(
      "yarden/fix-flicker",
    );
  });
});

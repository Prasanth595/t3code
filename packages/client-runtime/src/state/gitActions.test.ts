import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveQuickAction } from "./gitActions.ts";

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

describe("resolveQuickAction", () => {
  it("commits local changes without pushing when the branch is behind upstream", () => {
    const behind = status({ hasWorkingTreeChanges: true, behindCount: 2 });
    const commit = { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    expect(resolveQuickAction(behind, false)).toEqual(commit);
    expect(
      resolveQuickAction(
        {
          ...behind,
          pr: {
            number: 13,
            title: "Open PR",
            url: "https://example.com/pr/13",
            baseRef: "main",
            headRef: "feature/test",
            state: "open",
          },
        },
        false,
      ),
    ).toEqual(commit);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  forkWorkflowState,
  type GitHubCommit,
  type GitHubRelease,
  markForkCommits,
  orderForkReleases,
} from "./forkChangelogGitHub.ts";

const commit = (sha: string, parentCount = 1): GitHubCommit => ({
  sha,
  html_url: `https://github.com/Yarden-zamir/t3code/commit/${sha}`,
  parents: Array.from({ length: parentCount }, (_, index) => ({ sha: `${sha}-parent-${index}` })),
  author: sha === "u1" ? null : { login: `login-${sha}` },
  commit: {
    message: `subject ${sha}\n\nbody`,
    author: { name: "Author", date: "2026-10-12T00:00:00Z" },
  },
});

const release = (tag: string, publishedAt: string | null, draft = false): GitHubRelease => ({
  tag_name: tag,
  name: null,
  draft,
  published_at: publishedAt,
  html_url: `https://github.com/Yarden-zamir/t3code/releases/tag/${tag}`,
});

describe("markForkCommits", () => {
  it("keeps fork and upstream commits in one list, newest first, and drops merges", () => {
    const commits = markForkCommits(
      [commit("u1"), commit("f1"), commit("merge", 2), commit("u2"), commit("f2")],
      new Set(["f1", "f2", "merge"]),
    );

    expect(commits.map((entry) => [entry.sha, entry.fork])).toEqual([
      ["f2", true],
      ["u2", false],
      ["f1", true],
      ["u1", false],
    ]);
    expect(commits[0]?.subject).toBe("subject f2");
    expect(commits[0]?.authorLogin).toBe("login-f2");
    expect(commits[3]?.authorLogin).toBeNull();
  });
});

describe("orderForkReleases", () => {
  it("orders by version, not by publication, and skips drafts", () => {
    const ordered = orderForkReleases([
      // A local build published after the next CI release still sorts below it.
      release("v0.0.46-nightly.20261011.180845", "2026-10-11T20:00:00Z"),
      release("v0.0.46-nightly.20261011.190000", "2026-10-11T19:00:00Z"),
      release("v0.0.46-nightly.20261011.180000", "2026-10-11T18:00:00Z"),
      release("v0.0.46-nightly.20261010.11", "2026-10-10T23:00:00Z"),
      release("v0.0.46-nightly.20261012.10000", null, true),
    ]);

    expect(ordered.map((entry) => entry.version)).toEqual([
      "0.0.46-nightly.20261011.190000",
      "0.0.46-nightly.20261011.180845",
      "0.0.46-nightly.20261011.180000",
      "0.0.46-nightly.20261010.11",
    ]);
  });
});

describe("forkWorkflowState", () => {
  it("maps GitHub status and conclusion to one state", () => {
    expect(forkWorkflowState("queued", null)).toBe("queued");
    expect(forkWorkflowState("waiting", null)).toBe("queued");
    expect(forkWorkflowState("in_progress", null)).toBe("running");
    expect(forkWorkflowState("completed", "success")).toBe("success");
    expect(forkWorkflowState("completed", "timed_out")).toBe("failure");
    expect(forkWorkflowState("completed", "action_required")).toBe("failure");
    expect(forkWorkflowState("completed", "cancelled")).toBe("cancelled");
    expect(forkWorkflowState("completed", "skipped")).toBe("skipped");
    expect(forkWorkflowState("completed", null)).toBe("running");
  });
});

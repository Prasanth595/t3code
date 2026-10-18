import { describe, expect, it } from "vite-plus/test";
import type { GitHistoryCommit } from "@t3tools/contracts";
import { layoutGitGraph } from "./gitGraph.ts";

const commit = (sha: string, parents: string[]): GitHistoryCommit => ({
  sha,
  parents,
  subject: sha,
  author: "Test",
  authoredAt: "2026-10-18T12:00:00Z",
  branches: [],
});

describe("layoutGitGraph", () => {
  it("keeps a linear history in one lane and ends at the root", () => {
    const graph = layoutGitGraph([commit("a", ["b"]), commit("b", ["c"]), commit("c", [])]);
    expect(new Set(graph.rows.map((row) => row.x)).size).toBe(1);
    expect(new Set(graph.rows.map((row) => row.color)).size).toBe(1);
    expect(graph.rows[2]?.paths).toHaveLength(1);
    expect(graph.rows[2]?.paths[0]?.d).not.toContain("32");
  });
  it("separates both sides of a merge and rejoins their common ancestor", () => {
    const graph = layoutGitGraph([
      commit("merge", ["head", "base"]),
      commit("head", ["root"]),
      commit("base", ["root"]),
      commit("root", []),
    ]);
    const [merge, head, base, root] = graph.rows;
    expect(head?.x).toBe(merge?.x);
    expect(head?.x).not.toBe(base?.x);
    expect(merge?.paths).toHaveLength(2);
    expect(root?.paths).toHaveLength(1);
    expect(root?.x).toBe(head?.x);
  });
  it("preserves a waiting branch while independent commits pass it", () => {
    const graph = layoutGitGraph([
      commit("a", ["root"]),
      commit("other", ["old"]),
      commit("old", ["root"]),
      commit("root", []),
    ]);
    expect(graph.rows[1]?.x).not.toBe(graph.rows[0]?.x);
    expect(graph.rows[1]?.paths.some((path) => path.d.endsWith("V 32"))).toBe(true);
    expect(graph.rows[3]?.x).toBe(graph.rows[0]?.x);
  });
  it("handles shallow history, octopus merges, duplicate parents and an empty repository", () => {
    expect(layoutGitGraph([]).rows).toEqual([]);
    const graph = layoutGitGraph([commit("merge", ["a", "b", "c", "c"])]);
    expect(graph.rows[0]?.paths).toHaveLength(3);
    expect(graph.width).toBeGreaterThan(24);
    expect(JSON.stringify(graph)).not.toMatch(/NaN|Infinity/);
  });
});

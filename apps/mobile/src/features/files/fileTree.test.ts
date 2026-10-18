import { describe, expect, it } from "vite-plus/test";
import type { ProjectEntry } from "@t3tools/contracts";

import { buildFileTree, defaultExpandedTreePaths, flattenFileTree } from "./fileTree";

const entries = [
  { kind: "file", path: "README.md" },
  { kind: "directory", path: "src" },
  { kind: "file", path: "src/index.ts" },
  { kind: "file", path: "src/components/App.tsx" },
  { kind: "file", path: "package.json" },
] satisfies ReadonlyArray<ProjectEntry>;

describe("mobile file tree helpers", () => {
  it("builds a deterministic hierarchy with directories before files", () => {
    const tree = buildFileTree(entries);

    expect(tree.map((node) => `${node.kind}:${node.path}`)).toEqual([
      "directory:src",
      "file:package.json",
      "file:README.md",
    ]);
    expect(tree[0]?.children.map((node) => `${node.kind}:${node.path}`)).toEqual([
      "directory:src/components",
      "file:src/index.ts",
    ]);
  });

  it("flattens expanded directories and hides collapsed descendants", () => {
    const tree = buildFileTree(entries);

    expect(
      flattenFileTree({
        nodes: tree,
        expanded: new Set(["src"]),
      }).map((item) => `${item.depth}:${item.node.path}`),
    ).toEqual(["0:src", "1:src/components", "1:src/index.ts", "0:package.json", "0:README.md"]);

    expect(
      flattenFileTree({
        nodes: tree,
        expanded: new Set(),
      }).map((item) => item.node.path),
    ).toEqual(["src", "package.json", "README.md"]);
  });

  it("includes matching descendants and their ancestors during search", () => {
    const tree = buildFileTree(entries);

    expect(
      flattenFileTree({
        nodes: tree,
        expanded: new Set(),
        searchResultPaths: new Set(["src/components/App.tsx"]),
      }).map((item) => item.node.path),
    ).toEqual(["src", "src/components", "src/components/App.tsx"]);
  });

  it("excludes cached children of matched directories", () => {
    expect(
      flattenFileTree({
        nodes: buildFileTree(entries),
        expanded: new Set(["src", "src/components"]),
        searchResultPaths: new Set(["src/components"]),
      }).map((item) => item.node.path),
    ).toEqual(["src", "src/components"]);
  });

  it("keeps an empty search empty and restores expansion when search clears", () => {
    const tree = buildFileTree(entries);
    expect(
      flattenFileTree({ nodes: tree, expanded: new Set(["src"]), searchResultPaths: new Set() }),
    ).toEqual([]);
    expect(
      flattenFileTree({ nodes: tree, expanded: new Set(), searchResultPaths: null }).map(
        (item) => item.node.path,
      ),
    ).toEqual(["src", "package.json", "README.md"]);
  });

  it("expands top-level directories by default", () => {
    const tree = buildFileTree(entries);

    expect([...defaultExpandedTreePaths(tree)]).toEqual(["src"]);
  });
});

it("flattens a wide expanded directory without exceeding argument limits", () => {
  const children = Array.from({ length: 200_000 }, (_, index) => ({
    path: `root/file-${index}`,
    name: `file-${index}`,
    kind: "file" as const,
    children: [],
  }));
  const nodes = [{ path: "root", name: "root", kind: "directory" as const, children }];
  const rows = flattenFileTree({ nodes, expanded: new Set(["root"]) });
  expect(rows).toHaveLength(children.length + 1);
  expect(rows[0]).toEqual({ node: nodes[0], depth: 0 });
  const middleChildIndex = Math.floor(children.length / 2);
  expect(rows[middleChildIndex + 1]).toEqual({
    node: children[middleChildIndex],
    depth: 1,
  });
  expect(rows.at(-1)).toEqual({ node: children.at(-1), depth: 1 });
});

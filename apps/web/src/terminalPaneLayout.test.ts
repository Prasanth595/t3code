import { describe, expect, it } from "vite-plus/test";

import {
  buildFlatLayout,
  isTerminalPaneLayout,
  layoutDirection,
  layoutHasMixedDirections,
  layoutTerminalIds,
  normalizePaneLayout,
  normalizeSplitSizes,
  paneLayout,
  removePaneFromLayout,
  resizeSplitSizes,
  resolveTerminalPaneLayout,
  setSplitSizesAtPath,
  splitPaneLayout,
  splitSizes,
  terminalPaneLayoutEqual,
  type TerminalPaneLayout,
  type TerminalPaneLayoutPath,
  type TerminalSplitLayout,
} from "./terminalPaneLayout";

function splitNodeAtPath(
  layout: TerminalPaneLayout,
  path: TerminalPaneLayoutPath,
): TerminalSplitLayout | null {
  let node: TerminalPaneLayout = layout;
  for (const index of path) {
    if (node.kind !== "split" || index < 0 || index >= node.children.length) return null;
    node = node.children[index]!;
  }
  return node.kind === "split" ? node : null;
}

describe("terminalPaneLayout", () => {
  it("nests a split inside the active pane instead of re-splitting the whole tree", () => {
    // Regression for: splitting vertically then horizontally used to re-split
    // every pane into 3 horizontal panes instead of only the active one.
    const single = paneLayout("t1");
    const afterVertical = splitPaneLayout(single, "t1", "t2", "vertical");
    expect(afterVertical).toEqual({
      kind: "split",
      direction: "vertical",
      children: [paneLayout("t1"), paneLayout("t2")],
    });

    const afterHorizontal = splitPaneLayout(afterVertical, "t2", "t3", "horizontal");
    expect(afterHorizontal).toEqual({
      kind: "split",
      direction: "vertical",
      children: [
        paneLayout("t1"),
        {
          kind: "split",
          direction: "horizontal",
          children: [paneLayout("t2"), paneLayout("t3")],
        },
      ],
    });
    expect(layoutTerminalIds(afterHorizontal)).toEqual(["t1", "t2", "t3"]);
  });

  it("splits the active pane in half when splitting again in the same direction", () => {
    const layout = splitPaneLayout(paneLayout("t1"), "t1", "t2", "horizontal");
    const next = splitPaneLayout(layout, "t2", "t3", "horizontal");
    expect(layoutTerminalIds(next)).toEqual(["t1", "t2", "t3"]);
    expect(splitSizes(next as TerminalSplitLayout)).toEqual([0.5, 0.25, 0.25]);
  });

  it("attaches beside the tree when the active id is stale", () => {
    const layout = paneLayout("t1");
    const next = splitPaneLayout(layout, "missing", "t2", "horizontal");
    expect(next).toEqual({
      kind: "split",
      direction: "horizontal",
      children: [paneLayout("t1"), paneLayout("t2")],
    });
  });

  it("collapses a split down to its remaining sibling when a pane is removed", () => {
    const layout = splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical");
    expect(removePaneFromLayout(layout, "t2")).toEqual(paneLayout("t1"));
    expect(removePaneFromLayout(layout, "t1")).toEqual(paneLayout("t2"));
  });

  it("removes the whole tree once its last pane is removed", () => {
    expect(removePaneFromLayout(paneLayout("t1"), "t1")).toBeNull();
  });

  it("drops unknown or duplicate leaves and collapses single-child splits", () => {
    const layout = {
      kind: "split" as const,
      direction: "horizontal" as const,
      children: [paneLayout("t1"), paneLayout("stale")],
    };
    expect(normalizePaneLayout(layout, new Set(["t1"]))).toEqual(paneLayout("t1"));
    expect(normalizePaneLayout(layout, new Set(["stale-only"]))).toBeNull();
  });

  it("falls back to a flat layout for a pre-nested-split group", () => {
    expect(resolveTerminalPaneLayout(undefined, ["t1", "t2"], "vertical")).toEqual(
      buildFlatLayout(["t1", "t2"], "vertical"),
    );
    const validLayout = splitPaneLayout(paneLayout("t1"), "t1", "t2", "horizontal");
    expect(resolveTerminalPaneLayout(validLayout, ["t1", "t2"])).toEqual(validLayout);
  });

  it("rebuilds a flat layout when a corrupt persisted tree would drop a terminal id", () => {
    // A duplicated leaf normalizes structurally fine but silently loses "t2" —
    // must not be trusted, or that terminal disappears from the group.
    const corruptLayout = {
      kind: "split" as const,
      direction: "horizontal" as const,
      children: [paneLayout("t1"), paneLayout("t1")],
    };
    expect(resolveTerminalPaneLayout(corruptLayout, ["t1", "t2"])).toEqual(
      buildFlatLayout(["t1", "t2"]),
    );
  });

  it("validates layout shape defensively", () => {
    expect(isTerminalPaneLayout(paneLayout("t1"))).toBe(true);
    expect(isTerminalPaneLayout({ kind: "split", direction: "horizontal", children: [] })).toBe(
      false,
    );
    expect(isTerminalPaneLayout(undefined)).toBe(false);
    expect(isTerminalPaneLayout({ kind: "pane" })).toBe(false);
  });

  it("reads the root split direction, or null for a single pane", () => {
    expect(layoutDirection(paneLayout("t1"))).toBeNull();
    expect(layoutDirection(splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical"))).toBe(
      "vertical",
    );
  });

  it("detects a tree that nests both split directions", () => {
    const uniform = splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical");
    expect(layoutHasMixedDirections(uniform)).toBe(false);

    const mixed = splitPaneLayout(uniform, "t2", "t3", "horizontal");
    expect(layoutHasMixedDirections(mixed)).toBe(true);
  });

  it("compares layouts structurally", () => {
    const a = splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical");
    const b = splitPaneLayout(paneLayout("t1"), "t1", "t2", "vertical");
    expect(terminalPaneLayoutEqual(a, b)).toBe(true);
    expect(terminalPaneLayoutEqual(a, paneLayout("t1"))).toBe(false);
  });

  describe("pane sizing", () => {
    const split = (children: TerminalSplitLayout["children"], sizes?: number[]) =>
      ({
        kind: "split" as const,
        direction: "horizontal" as const,
        children,
        ...(sizes ? { sizes } : {}),
      }) satisfies TerminalSplitLayout;

    it("splitSizes returns equal shares for a legacy node with no sizes", () => {
      const node = split([paneLayout("t1"), paneLayout("t2")]);
      expect(splitSizes(node)).toEqual([0.5, 0.5]);
    });

    it("splitSizes returns equal shares for corrupt sizes", () => {
      const children = [paneLayout("t1"), paneLayout("t2")];
      expect(splitSizes(split(children, [1]))).toEqual([0.5, 0.5]); // wrong length
      expect(splitSizes(split(children, [Number.NaN, 1]))).toEqual([0.5, 0.5]);
      expect(splitSizes(split(children, [-1, 1]))).toEqual([0.5, 0.5]);
      expect(splitSizes(split(children, [0, 0]))).toEqual([0.5, 0.5]);
    });

    it("splitSizes renormalizes explicit weights", () => {
      const node = split([paneLayout("t1"), paneLayout("t2")], [3, 1]);
      expect(splitSizes(node)).toEqual([0.75, 0.25]);
    });

    it("normalizeSplitSizes returns undefined for equal or corrupt input", () => {
      expect(normalizeSplitSizes([0.5, 0.5], 2)).toBeUndefined();
      expect(normalizeSplitSizes([1], 2)).toBeUndefined();
      expect(normalizeSplitSizes([Number.NaN, 1], 2)).toBeUndefined();
      expect(normalizeSplitSizes(undefined, 2)).toBeUndefined();
    });

    it("normalizeSplitSizes renormalizes and clamps to the floor", () => {
      expect(normalizeSplitSizes([3, 1], 2)).toEqual([0.75, 0.25]);
      const clamped = normalizeSplitSizes([0.001, 0.999], 2)!;
      expect(clamped[0]).toBeCloseTo(0.05);
      expect(clamped[0]! + clamped[1]!).toBeCloseTo(1);

      // Clamping then renormalizing used to leave the raised weight just under
      // the floor. Taking the excess from the headroom above it keeps both.
      const slightlyUnder = normalizeSplitSizes([0.04, 0.96], 2)!;
      expect(Math.min(...slightlyUnder)).toBeGreaterThanOrEqual(0.05 - 1e-9);
      expect(slightlyUnder[0]! + slightlyUnder[1]!).toBeCloseTo(1);
      const normalizedAgain = normalizeSplitSizes(slightlyUnder, 2)!;
      normalizedAgain.forEach((value, index) => expect(value).toBeCloseTo(slightlyUnder[index]!));

      const threeWays = normalizeSplitSizes([0.01, 0.01, 0.98], 3)!;
      expect(Math.min(...threeWays)).toBeGreaterThanOrEqual(0.05 - 1e-9);
      expect(threeWays.reduce((total, value) => total + value, 0)).toBeCloseTo(1);
    });

    it("resizeSplitSizes moves only the two adjacent weights and keeps the sum at 1", () => {
      const next = resizeSplitSizes({
        sizes: [0.5, 0.5],
        index: 0,
        availablePx: 1000,
        deltaPx: 100,
        minPanePx: 50,
      });
      expect(next).toEqual([0.6, 0.4]);
    });

    it("resizeSplitSizes leaves other siblings untouched in a 3-way split", () => {
      const next = resizeSplitSizes({
        sizes: [1 / 3, 1 / 3, 1 / 3],
        index: 0,
        availablePx: 900,
        deltaPx: 90,
        minPanePx: 50,
      });
      expect(next[2]).toBeCloseTo(1 / 3);
      expect(next[0]! + next[1]!).toBeCloseTo(2 / 3);
    });

    it("resizeSplitSizes clamps at minPanePx on both ends", () => {
      const shrunk = resizeSplitSizes({
        sizes: [0.5, 0.5],
        index: 0,
        availablePx: 1000,
        deltaPx: -1000,
        minPanePx: 100,
      });
      expect(shrunk[0]).toBeCloseTo(0.1);
      const grown = resizeSplitSizes({
        sizes: [0.5, 0.5],
        index: 0,
        availablePx: 1000,
        deltaPx: 1000,
        minPanePx: 100,
      });
      expect(grown[0]).toBeCloseTo(0.9);
    });

    it("resizeSplitSizes returns the same array reference for a zero or fully-clamped delta", () => {
      const sizes = [0.5, 0.5];
      expect(
        resizeSplitSizes({ sizes, index: 0, availablePx: 1000, deltaPx: 0, minPanePx: 50 }),
      ).toBe(sizes);
      const atFloor = [0.05, 0.95];
      expect(
        resizeSplitSizes({
          sizes: atFloor,
          index: 0,
          availablePx: 1000,
          deltaPx: -1,
          minPanePx: 50,
        }),
      ).toBe(atFloor);
    });

    it("splitNodeAtPath walks a nested path and rejects a bad one", () => {
      const nested = split([paneLayout("t1"), split([paneLayout("t2"), paneLayout("t3")])]);
      expect(splitNodeAtPath(nested, [])).toEqual(nested);
      expect(splitNodeAtPath(nested, [1])).toEqual(nested.children[1]);
      expect(splitNodeAtPath(nested, [0])).toBeNull(); // a pane, not a split
      expect(splitNodeAtPath(nested, [5])).toBeNull();
    });

    it("setSplitSizesAtPath writes at a nested path without touching sibling subtrees", () => {
      const sibling = split([paneLayout("t2"), paneLayout("t3")]);
      const nested = split([paneLayout("t1"), sibling]);
      const next = setSplitSizesAtPath(nested, [1], [0.7, 0.3]) as TerminalSplitLayout;
      expect(splitNodeAtPath(next, [1])?.sizes).toEqual([0.7, 0.3]);
      expect(next.children[0]).toEqual(paneLayout("t1"));
    });

    it("setSplitSizesAtPath clears sizes when passed undefined", () => {
      const node = split([paneLayout("t1"), paneLayout("t2")], [0.7, 0.3]);
      const next = setSplitSizesAtPath(node, [], undefined) as TerminalSplitLayout;
      expect(next.sizes).toBeUndefined();
    });

    it("setSplitSizesAtPath is a no-op for a bad path or length mismatch", () => {
      const node = split([paneLayout("t1"), paneLayout("t2")]);
      expect(setSplitSizesAtPath(node, [5], [0.5, 0.5])).toBe(node);
      expect(setSplitSizesAtPath(node, [], [0.2, 0.3, 0.5])).toBe(node);
      expect(setSplitSizesAtPath(paneLayout("t1"), [], [0.5, 0.5])).toEqual(paneLayout("t1"));
    });

    it("splitPaneLayout splits a never-resized split at the active pane's middle", () => {
      const layout = splitPaneLayout(paneLayout("t1"), "t1", "t2", "horizontal");
      const next = splitPaneLayout(layout, "t2", "t3", "horizontal") as TerminalSplitLayout;
      const [first, second, third] = splitSizes(next);
      expect(first).toBe(0.5);
      expect(second).toBe(third);
    });

    it("splitPaneLayout halves the active child's share when the split was resized", () => {
      const resized = setSplitSizesAtPath(
        splitPaneLayout(paneLayout("t1"), "t1", "t2", "horizontal"),
        [],
        [0.8, 0.2],
      );
      const next = splitPaneLayout(resized, "t1", "t3", "horizontal") as TerminalSplitLayout;
      expect(splitSizes(next)).toEqual([0.4, 0.4, 0.2]);
    });

    it("removePaneFromLayout keeps the survivors' relative proportions", () => {
      const node = split([paneLayout("t1"), paneLayout("t2"), paneLayout("t3")], [0.2, 0.2, 0.6]);
      const next = removePaneFromLayout(node, "t2") as TerminalSplitLayout;
      const [first, second] = splitSizes(next);
      expect(first).toBeCloseTo(0.25);
      expect(second).toBeCloseTo(0.75);
    });

    it("removePaneFromLayout drops sizes when collapsing down to equal shares", () => {
      const node = split([paneLayout("t1"), paneLayout("t2"), paneLayout("t3")], [0.2, 0.4, 0.4]);
      const next = removePaneFromLayout(node, "t1") as TerminalSplitLayout;
      expect(next.sizes).toBeUndefined();
    });

    it("terminalPaneLayoutEqual treats absent sizes as equal shares", () => {
      const withoutSizes = split([paneLayout("t1"), paneLayout("t2")]);
      const withEqualSizes = split([paneLayout("t1"), paneLayout("t2")], [0.5, 0.5]);
      const withDifferentSizes = split([paneLayout("t1"), paneLayout("t2")], [0.6, 0.4]);
      expect(terminalPaneLayoutEqual(withoutSizes, withEqualSizes)).toBe(true);
      expect(terminalPaneLayoutEqual(withoutSizes, withDifferentSizes)).toBe(false);
    });

    it("resolveTerminalPaneLayout sanitizes corrupt sizes instead of falling back to flat", () => {
      const corruptSizes = split([paneLayout("t1"), paneLayout("t2")], [-1, 1]);
      const resolved = resolveTerminalPaneLayout(corruptSizes, ["t1", "t2"]) as TerminalSplitLayout;
      expect(layoutTerminalIds(resolved)).toEqual(["t1", "t2"]);
      expect(resolved.sizes).toBeUndefined();
    });
  });
});

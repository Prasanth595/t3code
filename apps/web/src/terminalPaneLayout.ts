/**
 * Recursive split tree for a terminal group. A flat "ids + one direction" model
 * cannot nest a split inside a split, so a second direction re-split every pane.
 * Here a split lives at any depth, anchored at the pane that was active.
 */

export type TerminalSplitDirection = "horizontal" | "vertical";

export type TerminalPaneLayout =
  | { kind: "pane"; terminalId: string }
  | {
      kind: "split";
      direction: TerminalSplitDirection;
      children: TerminalPaneLayout[];
      /** Normalized weights parallel to `children`, summing to 1. Absent means equal shares. */
      sizes?: readonly number[];
    };

export type TerminalSplitLayout = Extract<TerminalPaneLayout, { kind: "split" }>;

/** Structural floor so a drag can never squeeze a track to zero or negative width. */
export const MIN_SPLIT_CHILD_FRACTION = 0.05;

function isEqualShares(sizes: readonly number[]): boolean {
  const target = 1 / sizes.length;
  return sizes.every((value) => Math.abs(value - target) < 1e-4);
}

/** Always returns `children.length` weights summing to 1; equal shares when `sizes` is absent or invalid. */
export function splitSizes(node: TerminalSplitLayout): number[] {
  const equalShares = () => node.children.map(() => 1 / node.children.length);
  const { sizes } = node;
  if (!Array.isArray(sizes) || sizes.length !== node.children.length) return equalShares();
  if (!sizes.every((value) => Number.isFinite(value) && value > 0)) return equalShares();
  const sum = sizes.reduce((total, value) => total + value, 0);
  return sum > 0 ? sizes.map((value) => value / sum) : equalShares();
}

/**
 * Sanitizes persisted/unknown sizes: wrong length, non-finite, or non-positive
 * values fall back to equal shares. Renormalizes to sum 1, clamps each weight
 * to `MIN_SPLIT_CHILD_FRACTION`, and returns `undefined` when the result is
 * equal shares, so the node keeps its legacy (size-free) shape.
 */
export function normalizeSplitSizes(rawSizes: unknown, childCount: number): number[] | undefined {
  if (!Array.isArray(rawSizes) || rawSizes.length !== childCount) return undefined;
  if (
    !rawSizes.every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)
  ) {
    return undefined;
  }
  const sum = rawSizes.reduce((total: number, value: number) => total + value, 0);
  if (sum <= 0) return undefined;
  let normalized = rawSizes.map((value: number) => value / sum);
  if (normalized.some((value) => value < MIN_SPLIT_CHILD_FRACTION)) {
    const clamped = normalized.map((value) => Math.max(value, MIN_SPLIT_CHILD_FRACTION));
    // Clamping raises the sum above 1. Take the excess back only from the
    // headroom above the floor, so renormalizing cannot push a weight under it.
    const excess = clamped.reduce((total, value) => total + value, 0) - 1;
    const headroom = clamped.map((value) => value - MIN_SPLIT_CHILD_FRACTION);
    const totalHeadroom = headroom.reduce((total, value) => total + value, 0);
    normalized =
      excess > 0 && totalHeadroom > 0
        ? clamped.map((value, index) => value - (excess * headroom[index]!) / totalHeadroom)
        : clamped;
  }
  return isEqualShares(normalized) ? undefined : normalized;
}

/** Sets or clears a split's `sizes`, never storing an explicit `sizes: undefined`. */
function withChildSizes(
  node: TerminalSplitLayout,
  sizes: number[] | undefined,
): TerminalSplitLayout {
  if (sizes === undefined) {
    if (node.sizes === undefined) return node;
    const { sizes: _sizes, ...rest } = node;
    return rest;
  }
  return { ...node, sizes };
}

/**
 * Resizes the divider between `children[index]` and `children[index + 1]` by
 * `deltaPx`, clamping so neither neighbour drops below `minPanePx`. Returns
 * the input array unchanged (same reference) when the clamped delta is zero.
 */
export function resizeSplitSizes(options: {
  readonly sizes: readonly number[];
  readonly index: number;
  readonly availablePx: number;
  readonly deltaPx: number;
  readonly minPanePx: number;
}): readonly number[] {
  const { sizes, index, availablePx, deltaPx, minPanePx } = options;
  if (!Number.isFinite(availablePx) || availablePx <= 0 || deltaPx === 0) return sizes;
  if (index < 0 || index + 1 >= sizes.length) return sizes;
  const pairSum = sizes[index]! + sizes[index + 1]!;
  const minFraction = Math.min(pairSum / 2, minPanePx / availablePx);
  const deltaFraction = deltaPx / availablePx;
  const nextLeft = Math.max(
    minFraction,
    Math.min(pairSum - minFraction, sizes[index]! + deltaFraction),
  );
  if (nextLeft === sizes[index]) return sizes;
  const nextRight = pairSum - nextLeft;
  return sizes.map((value, position) =>
    position === index ? nextLeft : position === index + 1 ? nextRight : value,
  );
}

/** Path of child indices from the root to a split node; `[]` is the root. */
export type TerminalPaneLayoutPath = readonly number[];

/** Returns `layout` itself when the path misses a split, or the sizes are unchanged. */
export function setSplitSizesAtPath(
  layout: TerminalPaneLayout,
  path: TerminalPaneLayoutPath,
  sizes: number[] | undefined,
): TerminalPaneLayout {
  if (layout.kind !== "split") return layout;
  if (path.length === 0) {
    if (sizes !== undefined && sizes.length !== layout.children.length) return layout;
    return withChildSizes(layout, sizes);
  }
  const [index, ...rest] = path;
  if (index === undefined || index < 0 || index >= layout.children.length) return layout;
  const child = layout.children[index]!;
  const nextChild = setSplitSizesAtPath(child, rest, sizes);
  if (nextChild === child) return layout;
  const children = [...layout.children];
  children[index] = nextChild;
  return { ...layout, children };
}

export function paneLayout(terminalId: string): TerminalPaneLayout {
  return { kind: "pane", terminalId };
}

export function layoutTerminalIds(layout: TerminalPaneLayout): string[] {
  if (layout.kind === "pane") return [layout.terminalId];
  return layout.children.flatMap(layoutTerminalIds);
}

export function layoutDirection(layout: TerminalPaneLayout): TerminalSplitDirection | null {
  return layout.kind === "split" ? layout.direction : null;
}

/** True once a tree nests both a horizontal and a vertical split, so no single direction describes it. */
export function layoutHasMixedDirections(layout: TerminalPaneLayout): boolean {
  const directions = new Set<TerminalSplitDirection>();
  const collect = (node: TerminalPaneLayout): void => {
    if (node.kind !== "split") return;
    directions.add(node.direction);
    node.children.forEach(collect);
  };
  collect(layout);
  return directions.size > 1;
}

export function terminalPaneLayoutEqual(
  left: TerminalPaneLayout,
  right: TerminalPaneLayout,
): boolean {
  if (left.kind === "pane" || right.kind === "pane") {
    return left.kind === "pane" && right.kind === "pane" && left.terminalId === right.terminalId;
  }
  if (left.direction !== right.direction || left.children.length !== right.children.length) {
    return false;
  }
  const leftSizes = splitSizes(left);
  const rightSizes = splitSizes(right);
  if (leftSizes.some((value, index) => Math.abs(value - rightSizes[index]!) > 1e-4)) {
    return false;
  }
  return left.children.every((child, index) =>
    terminalPaneLayoutEqual(child, right.children[index]!),
  );
}

/** Builds the layout the same way a legacy flat group rendered: one level, one direction. */
export function buildFlatLayout(
  terminalIds: readonly string[],
  direction: TerminalSplitDirection = "horizontal",
): TerminalPaneLayout {
  if (terminalIds.length <= 1) {
    return paneLayout(terminalIds[0] ?? "");
  }
  return { kind: "split", direction, children: terminalIds.map(paneLayout) };
}

/** True when a layout's leaves are exactly `terminalIds`, no duplicates or omissions. */
function layoutMatchesIds(layout: TerminalPaneLayout, terminalIds: readonly string[]): boolean {
  const layoutIds = layoutTerminalIds(layout);
  if (layoutIds.length !== terminalIds.length) return false;
  const seen = new Set<string>();
  for (const id of layoutIds) {
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return terminalIds.every((id) => seen.has(id));
}

/**
 * Resolves whatever layout a group carries into a valid tree over its current
 * terminal ids: a genuine tree is pruned/collapsed, anything else (missing,
 * corrupt, or a pre-nested-split group's bare id list) falls back to the flat
 * layout a legacy group would have rendered.
 */
export function resolveTerminalPaneLayout(
  rawLayout: unknown,
  terminalIds: readonly string[],
  legacyDirection: TerminalSplitDirection = "horizontal",
): TerminalPaneLayout {
  if (isTerminalPaneLayout(rawLayout)) {
    const normalized = normalizePaneLayout(rawLayout, new Set(terminalIds));
    // A corrupt persisted layout (e.g. a duplicated leaf) can normalize to a
    // tree that drops one of `terminalIds` entirely; only trust it once its
    // leaves are a one-to-one match, otherwise fall through to a flat rebuild.
    if (normalized && layoutMatchesIds(normalized, terminalIds)) return normalized;
  }
  return buildFlatLayout(terminalIds, legacyDirection);
}

export function isTerminalPaneLayout(value: unknown): value is TerminalPaneLayout {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "pane") {
    return typeof (value as { terminalId?: unknown }).terminalId === "string";
  }
  if (kind === "split") {
    const { direction, children } = value as { direction?: unknown; children?: unknown };
    return (
      (direction === "horizontal" || direction === "vertical") &&
      Array.isArray(children) &&
      children.length > 0 &&
      children.every(isTerminalPaneLayout)
    );
  }
  return false;
}

interface InsertResult {
  layout: TerminalPaneLayout;
  inserted: boolean;
}

function insertIntoLayout(
  node: TerminalPaneLayout,
  direction: TerminalSplitDirection,
  activeTerminalId: string,
  newTerminalId: string,
): InsertResult {
  if (node.kind === "pane") {
    if (node.terminalId !== activeTerminalId) return { layout: node, inserted: false };
    return {
      layout: { kind: "split", direction, children: [node, paneLayout(newTerminalId)] },
      inserted: true,
    };
  }
  const activeIndex = node.children.findIndex((child) =>
    layoutTerminalIds(child).includes(activeTerminalId),
  );
  if (activeIndex < 0) return { layout: node, inserted: false };
  const activeChild = node.children[activeIndex]!;
  // Same direction as the split the active pane already sits in: grow that
  // split with an equal sibling instead of nesting another level.
  if (activeChild.kind === "pane" && node.direction === direction) {
    const children = [...node.children];
    children.splice(activeIndex + 1, 0, paneLayout(newTerminalId));
    // Split the active pane at its middle: it and its new sibling each take
    // half, while the other siblings keep the shares the user gave them.
    const currentSizes = splitSizes(node);
    const halved = currentSizes[activeIndex]! / 2;
    const nextSizes = [...currentSizes];
    nextSizes[activeIndex] = halved;
    nextSizes.splice(activeIndex + 1, 0, halved);
    return {
      layout: withChildSizes(
        { ...node, children },
        normalizeSplitSizes(nextSizes, nextSizes.length),
      ),
      inserted: true,
    };
  }
  const childResult = insertIntoLayout(activeChild, direction, activeTerminalId, newTerminalId);
  const children = [...node.children];
  children[activeIndex] = childResult.layout;
  return { layout: { ...node, children }, inserted: childResult.inserted };
}

/**
 * Splits the active pane in place: a split in the same direction as the
 * active pane's siblings cuts that pane in half, a split in a different
 * direction nests a new split at that pane instead of touching the rest of
 * the tree.
 */
export function splitPaneLayout(
  layout: TerminalPaneLayout,
  activeTerminalId: string,
  newTerminalId: string,
  direction: TerminalSplitDirection,
): TerminalPaneLayout {
  const result = insertIntoLayout(layout, direction, activeTerminalId, newTerminalId);
  if (result.inserted) return result.layout;
  // Stale active id (should not normally happen): attach beside the whole
  // tree rather than silently dropping the new pane.
  return { kind: "split", direction, children: [layout, paneLayout(newTerminalId)] };
}

export function removePaneFromLayout(
  layout: TerminalPaneLayout,
  terminalId: string,
): TerminalPaneLayout | null {
  if (layout.kind === "pane") {
    return layout.terminalId === terminalId ? null : layout;
  }
  const currentSizes = splitSizes(layout);
  const children: TerminalPaneLayout[] = [];
  const survivingSizes: number[] = [];
  layout.children.forEach((child, index) => {
    const nextChild = removePaneFromLayout(child, terminalId);
    if (nextChild === null) return;
    children.push(nextChild);
    survivingSizes.push(currentSizes[index]!);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return withChildSizes(
    { ...layout, children },
    normalizeSplitSizes(survivingSizes, children.length),
  );
}

/** Drops leaves outside `validTerminalIds` and collapses any split left with one child. */
export function normalizePaneLayout(
  layout: TerminalPaneLayout,
  validTerminalIds: ReadonlySet<string>,
): TerminalPaneLayout | null {
  if (layout.kind === "pane") {
    return validTerminalIds.has(layout.terminalId) ? layout : null;
  }
  const currentSizes = splitSizes(layout);
  const children: TerminalPaneLayout[] = [];
  const survivingSizes: number[] = [];
  layout.children.forEach((child, index) => {
    const normalizedChild = normalizePaneLayout(child, validTerminalIds);
    if (normalizedChild === null) return;
    children.push(normalizedChild);
    survivingSizes.push(currentSizes[index]!);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return withChildSizes(
    { ...layout, children },
    normalizeSplitSizes(survivingSizes, children.length),
  );
}

import { type ReactNode, type RefObject, useRef } from "react";
import { useResizeDrag } from "~/hooks/useResizeDrag";
import { cn } from "~/lib/utils";
import {
  layoutTerminalIds,
  MIN_SPLIT_CHILD_FRACTION,
  resizeSplitSizes,
  splitSizes,
  type TerminalPaneLayout,
  type TerminalPaneLayoutPath,
  type TerminalSplitDirection,
} from "../terminalPaneLayout";

/** A terminal smaller than this is useless; both neighbours of a drag are clamped to it. */
const TERMINAL_PANE_MIN_PX = 64;
const TERMINAL_DIVIDER_PX = 1;

/** e.g. "minmax(0, 0.62fr) 1px minmax(0, 0.38fr)". */
function splitGridTemplate(sizes: readonly number[], dividerPx: number): string {
  const tracks: string[] = [];
  sizes.forEach((size, index) => {
    if (index > 0) tracks.push(`${dividerPx}px`);
    tracks.push(`minmax(0, ${size}fr)`);
  });
  return tracks.join(" ");
}

interface TerminalPaneTreeProps {
  layout: TerminalPaneLayout;
  activeTerminalId: string;
  renderPane: (terminalId: string) => ReactNode;
  /** Absent: dividers render as inert 1px lines with no drag handling. */
  onPaneSizesChange?:
    | ((path: TerminalPaneLayoutPath, sizes: number[] | undefined) => void)
    | undefined;
}

/**
 * Renders a split-pane tree: a leaf is one terminal, a split lays out its children in a resizable grid.
 * A leaf keeps the split's grid shape so appending or removing a sibling keeps the surviving panes
 * in place; nesting the active pane still re-creates that pane's viewport, which re-attaches to the
 * same server-side session.
 */
export function TerminalPaneTree(props: TerminalPaneTreeProps) {
  return <TerminalPaneNode {...props} path={[]} />;
}

interface TerminalPaneNodeProps extends TerminalPaneTreeProps {
  path: TerminalPaneLayoutPath;
}

/** A subtree's identity: every leaf terminal id is unique across the tree. */
function nodeKey(node: TerminalPaneLayout): string {
  return node.kind === "pane" ? node.terminalId : layoutTerminalIds(node)[0]!;
}

function TerminalPaneNode({
  layout,
  path,
  activeTerminalId,
  renderPane,
  onPaneSizesChange,
}: TerminalPaneNodeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  if (layout.kind === "pane") {
    return (
      <div
        ref={containerRef}
        className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
        style={{ gridTemplateColumns: "minmax(0, 1fr)" }}
      >
        <div key={layout.terminalId} className="min-h-0 min-w-0">
          {renderPane(layout.terminalId)}
        </div>
      </div>
    );
  }
  const sizes = splitSizes(layout);
  const template = splitGridTemplate(sizes, TERMINAL_DIVIDER_PX);
  return (
    <div
      ref={containerRef}
      className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
      style={
        layout.direction === "vertical"
          ? { gridTemplateRows: template }
          : { gridTemplateColumns: template }
      }
    >
      {layout.children.flatMap((child, index) => [
        index > 0 ? (
          <TerminalSplitDivider
            key={`divider-${nodeKey(child)}`}
            direction={layout.direction}
            index={index - 1}
            sizes={sizes}
            containerRef={containerRef}
            active={
              layoutTerminalIds(child).includes(activeTerminalId) ||
              layoutTerminalIds(layout.children[index - 1]!).includes(activeTerminalId)
            }
            {...(onPaneSizesChange
              ? {
                  onCommit: (nextSizes: number[] | undefined) => onPaneSizesChange(path, nextSizes),
                }
              : {})}
          />
        ) : null,
        <div key={nodeKey(child)} className="min-h-0 min-w-0">
          {child.kind === "pane" ? (
            renderPane(child.terminalId)
          ) : (
            <TerminalPaneNode
              layout={child}
              path={[...path, index]}
              activeTerminalId={activeTerminalId}
              renderPane={renderPane}
              onPaneSizesChange={onPaneSizesChange}
            />
          )}
        </div>,
      ])}
    </div>
  );
}

interface TerminalSplitDividerProps {
  readonly direction: TerminalSplitDirection;
  /** Divider between sizes[index] and sizes[index + 1]. */
  readonly index: number;
  readonly sizes: readonly number[];
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly active: boolean;
  /** Absent: the divider stays inert, matching the tree's optional size callback. */
  readonly onCommit?: ((sizes: number[] | undefined) => void) | undefined;
}

function TerminalSplitDivider({
  direction,
  index,
  sizes,
  containerRef,
  active,
  onCommit,
}: TerminalSplitDividerProps) {
  const axis = direction === "vertical" ? "y" : "x";
  const trackProperty = axis === "y" ? "grid-template-rows" : "grid-template-columns";
  // The handler identity is per render, so it reads the committed sizes directly.
  const handlers = useResizeDrag<HTMLDivElement>(() => {
    const commit = onCommit;
    if (!commit) return null;
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const axisLengthPx = axis === "y" ? rect.height : rect.width;
    const startSizes = sizes;
    const dividerCount = startSizes.length - 1;
    const availablePx = axisLengthPx - dividerCount * TERMINAL_DIVIDER_PX;
    if (!Number.isFinite(availablePx) || availablePx <= 0) return null;

    const startWidthPx = startSizes[index]! * availablePx;
    // The store re-applies the layout's share floor on every update, so the drag
    // has to clamp to the larger of it and the pixel minimum, or a committed
    // share grows on the next render without another drag.
    const minPanePx = Math.max(TERMINAL_PANE_MIN_PX, MIN_SPLIT_CHILD_FRACTION * availablePx);
    let latestResult: number[] | null = null;
    const restoreStart = () =>
      container.style.setProperty(
        trackProperty,
        splitGridTemplate(startSizes, TERMINAL_DIVIDER_PX),
      );

    return {
      width: startWidthPx,
      edge: "right",
      bounds: { min: 0, max: Number.POSITIVE_INFINITY },
      axis,
      resize(px) {
        const nextSizes = resizeSplitSizes({
          sizes: startSizes,
          index,
          availablePx,
          deltaPx: px - startWidthPx,
          minPanePx,
        });
        if (nextSizes === startSizes) {
          // Back at the starting share (or clamped onto it): drop the preview so
          // there is nothing left to commit.
          latestResult = null;
          restoreStart();
          return startWidthPx;
        }
        latestResult = nextSizes as number[];
        container.style.setProperty(
          trackProperty,
          splitGridTemplate(nextSizes, TERMINAL_DIVIDER_PX),
        );
        return nextSizes[index]! * availablePx;
      },
      finish(_px, moved) {
        // A sub-threshold drag, or one that returned to its start, must leave both
        // the stored sizes and the grid on the committed template.
        if (!moved || latestResult === null) {
          restoreStart();
          return;
        }
        commit(latestResult);
      },
    };
  });
  const { refresh: _refresh, cancel: _cancel, ...pointerHandlers } = handlers;

  return (
    <div
      role="separator"
      aria-orientation={direction === "vertical" ? "horizontal" : "vertical"}
      className={cn(
        "group relative z-10 touch-none select-none",
        onCommit !== undefined && (axis === "x" ? "cursor-col-resize" : "cursor-row-resize"),
      )}
      {...pointerHandlers}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute transition-colors duration-150",
          axis === "x"
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2",
          active ? "bg-border" : "bg-border/70",
          "group-hover:bg-border group-active:bg-primary/60",
        )}
      />
      <div
        aria-hidden
        className={cn("absolute", axis === "x" ? "-inset-x-1 inset-y-0" : "-inset-y-1 inset-x-0")}
      />
    </div>
  );
}

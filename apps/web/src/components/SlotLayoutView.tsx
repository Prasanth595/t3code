import type { SlotLayout } from "@t3tools/contracts";
import { Fragment, type ReactNode } from "react";

import { cn } from "~/lib/utils";

/** Every row is `h-5` with a `gap-0.5` between rows. */
const ROW_HEIGHT_PX = 20;
const ROW_GAP_PX = 2;

/** Content height of a rendered layout, for `contain-intrinsic-size` and other size estimates. */
export function slotLayoutHeightPx(layout: SlotLayout<string>): number {
  return layout.rows.length * ROW_HEIGHT_PX + (layout.rows.length - 1) * ROW_GAP_PX;
}

/**
 * Renders a user-arranged slot layout. The surface supplies one node per
 * element; an element with nothing to show returns null and takes no space.
 * The start group takes the free width and truncates, the end group keeps its
 * size at the right edge.
 */
export function SlotLayoutView<Element extends string>(props: {
  layout: SlotLayout<Element>;
  renderElement: (element: Element) => ReactNode;
  className?: string;
}) {
  const renderGroup = (elements: ReadonlyArray<Element>) =>
    elements.map((element) => <Fragment key={element}>{props.renderElement(element)}</Fragment>);
  return (
    <div className={cn("flex flex-col gap-0.5", props.className)}>
      {props.layout.rows.map((row, rowIndex) => (
        // Rows have no identity apart from their position in the layout.
        <div
          key={rowIndex}
          className="flex h-5 min-w-0 items-center gap-1.5 text-secondary-label text-xs"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">{renderGroup(row.start)}</div>
          {row.end.length > 0 ? (
            <div className="flex shrink-0 items-center gap-1.5">{renderGroup(row.end)}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

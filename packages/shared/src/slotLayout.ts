import {
  MAX_SLOT_LAYOUT_ROWS,
  slotLayoutElements,
  type SlotLayout,
  type SlotLayoutGroup,
  type SlotLayoutRow,
} from "@t3tools/contracts";

/** Where one element sits in a layout. */
interface SlotLayoutPosition {
  readonly row: number;
  readonly group: SlotLayoutGroup;
  readonly index: number;
}

export function findSlotLayoutElement<Element extends string>(
  layout: SlotLayout<Element>,
  element: Element,
): SlotLayoutPosition | null {
  for (const [row, slots] of layout.rows.entries()) {
    for (const group of ["start", "end"] as const) {
      const index = slots[group].indexOf(element);
      if (index !== -1) return { row, group, index };
    }
  }
  return null;
}

/** Elements of the surface that the layout does not place, in catalog order. */
export function unplacedSlotLayoutElements<Element extends string>(
  layout: SlotLayout<Element>,
  elements: ReadonlyArray<Element>,
): ReadonlyArray<Element> {
  const placed = new Set(slotLayoutElements(layout));
  return elements.filter((element) => !placed.has(element));
}

function withoutElement<Element extends string>(
  layout: SlotLayout<Element>,
  element: Element,
): SlotLayout<Element> {
  return {
    rows: layout.rows.map((row) => ({
      start: row.start.filter((id) => id !== element),
      end: row.end.filter((id) => id !== element),
    })),
  };
}

function updateRow<Element extends string>(
  layout: SlotLayout<Element>,
  rowIndex: number,
  update: (row: SlotLayoutRow<Element>) => SlotLayoutRow<Element>,
): SlotLayout<Element> {
  if (rowIndex < 0 || rowIndex >= layout.rows.length) {
    throw new RangeError(`Slot layout has no row ${rowIndex}`);
  }
  return { rows: layout.rows.map((row, index) => (index === rowIndex ? update(row) : row)) };
}

/**
 * Puts the element into a group at `index`, or at the end without one. The
 * element first leaves wherever it was, so a move within one group follows
 * array-move semantics: the element ends at `index`.
 */
export function placeSlotLayoutElement<Element extends string>(
  layout: SlotLayout<Element>,
  element: Element,
  rowIndex: number,
  group: SlotLayoutGroup,
  index?: number,
): SlotLayout<Element> {
  return updateRow(withoutElement(layout, element), rowIndex, (row) => {
    const next = [...row[group]];
    next.splice(Math.min(Math.max(index ?? next.length, 0), next.length), 0, element);
    return { ...row, [group]: next };
  });
}

export function removeSlotLayoutElement<Element extends string>(
  layout: SlotLayout<Element>,
  element: Element,
  required: ReadonlyArray<Element>,
): SlotLayout<Element> {
  if (required.includes(element)) {
    throw new Error(`Slot layout element "${element}" is required`);
  }
  return withoutElement(layout, element);
}

export function canAddSlotLayoutRow<Element extends string>(layout: SlotLayout<Element>): boolean {
  return layout.rows.length < MAX_SLOT_LAYOUT_ROWS;
}

export function addSlotLayoutRow<Element extends string>(
  layout: SlotLayout<Element>,
): SlotLayout<Element> {
  if (!canAddSlotLayoutRow(layout)) {
    throw new RangeError(`Slot layouts have at most ${MAX_SLOT_LAYOUT_ROWS} rows`);
  }
  return { rows: [...layout.rows, { start: [], end: [] }] };
}

/** A row can go when it is not the last one and holds no required element. */
export function canRemoveSlotLayoutRow<Element extends string>(
  layout: SlotLayout<Element>,
  rowIndex: number,
  required: ReadonlyArray<Element>,
): boolean {
  const row = layout.rows[rowIndex];
  return (
    row !== undefined &&
    layout.rows.length > 1 &&
    ![...row.start, ...row.end].some((element) => required.includes(element))
  );
}

/** Removes the row. Its elements go back to the unplaced list. */
export function removeSlotLayoutRow<Element extends string>(
  layout: SlotLayout<Element>,
  rowIndex: number,
  required: ReadonlyArray<Element>,
): SlotLayout<Element> {
  if (!canRemoveSlotLayoutRow(layout, rowIndex, required)) {
    throw new Error(`Slot layout row ${rowIndex} cannot be removed`);
  }
  return { rows: layout.rows.filter((_, index) => index !== rowIndex) };
}

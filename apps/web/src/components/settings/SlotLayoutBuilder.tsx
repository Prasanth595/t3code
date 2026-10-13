import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SlotLayout, SlotLayoutGroup } from "@t3tools/contracts";
import {
  addSlotLayoutRow,
  canAddSlotLayoutRow,
  canRemoveSlotLayoutRow,
  findSlotLayoutElement,
  placeSlotLayoutElement,
  removeSlotLayoutElement,
  removeSlotLayoutRow,
  unplacedSlotLayoutElements,
} from "@t3tools/shared/slotLayout";
import { GripVerticalIcon, LockIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState, type ComponentType, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SlotLayoutElementOption<Element extends string> {
  readonly id: Element;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
}

/** Where a drag can drop: one group of one row, or the hidden tray. */
type SlotTarget = { readonly row: number; readonly group: SlotLayoutGroup } | "hidden";

// Container ids carry a prefix so they never collide with element ids.
const HIDDEN_ID = "slot-layout:hidden";
const groupId = (row: number, group: SlotLayoutGroup) => `slot-layout:${row}:${group}`;

function parseContainerId(id: string): SlotTarget | null {
  if (id === HIDDEN_ID) return "hidden";
  const [prefix, row, group] = id.split(":");
  if (prefix !== "slot-layout" || row === undefined || (group !== "start" && group !== "end")) {
    return null;
  }
  return { row: Number(row), group };
}

// Pointer position first, so a drop lands in the zone under the cursor even
// when a neighbouring zone overlaps the dragged chip more.
const collisionDetection: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

/**
 * Edits a slot layout by drag and drop: rows of a left group and a right
 * group, plus a tray of hidden elements. Any surface with a `SlotLayout`
 * schema can use it with its own element list. `renderPreview` receives the
 * layout as it looks mid-drag, so the preview follows the pointer.
 */
export function SlotLayoutBuilder<Element extends string>(props: {
  layout: SlotLayout<Element>;
  elements: ReadonlyArray<SlotLayoutElementOption<Element>>;
  required: ReadonlyArray<Element>;
  onChange: (layout: SlotLayout<Element>) => void;
  renderPreview?: (layout: SlotLayout<Element>) => ReactNode;
}) {
  const { required, onChange } = props;
  // The layout as the user last left it, tied to the saved layout it started
  // from. A drop shows at once; the next saved layout replaces it. A save that
  // fails leaves the draft on screen until the page reloads, which is
  // acceptable while saves only fail on a lost connection.
  const [draft, setDraft] = useState<{
    base: SlotLayout<Element>;
    layout: SlotLayout<Element>;
  } | null>(null);
  const [activeElement, setActiveElement] = useState<Element | null>(null);
  const layout = draft !== null && draft.base === props.layout ? draft.layout : props.layout;
  const setDraftLayout = (next: SlotLayout<Element>) =>
    setDraft({ base: props.layout, layout: next });

  const optionOf = (element: Element) => {
    const option = props.elements.find((candidate) => candidate.id === element);
    if (option === undefined) throw new Error(`Slot layout element "${element}" has no option`);
    return option;
  };
  const isElement = (id: UniqueIdentifier): id is Element =>
    props.elements.some((option) => option.id === id);
  const unplaced = unplacedSlotLayoutElements(
    layout,
    props.elements.map((option) => option.id),
  );

  const commit = (next: SlotLayout<Element>) => {
    setDraftLayout(next);
    onChange(next);
  };
  const targetOf = (id: UniqueIdentifier): SlotTarget | null => {
    if (isElement(id)) {
      const position = findSlotLayoutElement(layout, id);
      return position === null ? "hidden" : { row: position.row, group: position.group };
    }
    return parseContainerId(String(id));
  };
  /** The layout after moving `element` over `overId`, or null when the move is not allowed. */
  const moved = (element: Element, overId: UniqueIdentifier): SlotLayout<Element> | null => {
    const target = targetOf(overId);
    if (target === null) return null;
    if (target === "hidden") {
      if (required.includes(element)) return null;
      return findSlotLayoutElement(layout, element) === null
        ? layout
        : removeSlotLayoutElement(layout, element, required);
    }
    const group = layout.rows[target.row]?.[target.group];
    if (group === undefined) return null;
    const overIndex = isElement(overId) ? group.indexOf(overId) : -1;
    return placeSlotLayoutElement(
      layout,
      element,
      target.row,
      target.group,
      overIndex === -1 ? group.length : overIndex,
    );
  };

  const sensors = useSensors(
    // A small distance keeps a plain click on a chip button a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragStart = ({ active }: DragStartEvent) => {
    if (isElement(active.id)) setActiveElement(active.id);
  };
  // Moves between groups happen while dragging, so the chip and the preview
  // follow the pointer. Order within a group settles on drop.
  const handleDragOver = ({ active, over }: DragOverEvent) => {
    if (over === null || !isElement(active.id)) return;
    const from = targetOf(active.id);
    const to = targetOf(over.id);
    if (from === null || to === null) return;
    const sameGroup =
      from === "hidden" || to === "hidden"
        ? from === to
        : from.row === to.row && from.group === to.group;
    if (sameGroup) return;
    const next = moved(active.id, over.id);
    if (next !== null) setDraftLayout(next);
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveElement(null);
    if (!isElement(active.id)) return;
    const next = over === null ? layout : (moved(active.id, over.id) ?? layout);
    // A drop that changes nothing saves nothing.
    if (next === props.layout) setDraft(null);
    else commit(next);
  };
  const handleDragCancel = () => {
    setActiveElement(null);
    setDraft(null);
  };

  const hide = (element: Element) => commit(removeSlotLayoutElement(layout, element, required));
  const show = (element: Element) => {
    const lastRow = layout.rows.length - 1;
    commit(placeSlotLayoutElement(layout, element, lastRow, "start"));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex flex-col gap-3">
        {props.renderPreview?.(layout)}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-2">
            {layout.rows.map((row, rowIndex) => (
              // Rows have no identity apart from their position in the layout.
              <div key={rowIndex} className="flex items-stretch gap-2">
                <DropZone id={groupId(rowIndex, "start")} label="Left" className="flex-1">
                  <SortableContext items={[...row.start]} strategy={rectSortingStrategy}>
                    {row.start.map((element) => (
                      <SlotChip
                        key={element}
                        option={optionOf(element)}
                        required={required.includes(element)}
                        onHide={() => hide(element)}
                      />
                    ))}
                  </SortableContext>
                </DropZone>
                <DropZone
                  id={groupId(rowIndex, "end")}
                  label="Right"
                  className="flex-1 justify-end"
                  // Rows that hold a required element cannot go, so they show no delete.
                  corner={
                    canRemoveSlotLayoutRow(layout, rowIndex, required) ? (
                      <Button
                        type="button"
                        variant="ghost-destructive"
                        size="icon-tiny"
                        aria-label={`Remove row ${rowIndex + 1}`}
                        onClick={() => commit(removeSlotLayoutRow(layout, rowIndex, required))}
                      >
                        <Trash2Icon />
                      </Button>
                    ) : null
                  }
                >
                  <SortableContext items={[...row.end]} strategy={rectSortingStrategy}>
                    {row.end.map((element) => (
                      <SlotChip
                        key={element}
                        option={optionOf(element)}
                        required={required.includes(element)}
                        onHide={() => hide(element)}
                      />
                    ))}
                  </SortableContext>
                </DropZone>
              </div>
            ))}
            <div className="flex justify-start">
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={!canAddSlotLayoutRow(layout)}
                onClick={() => commit(addSlotLayoutRow(layout))}
              >
                <PlusIcon />
                Add row
              </Button>
            </div>
          </div>
          <DropZone id={HIDDEN_ID} label="Hidden" className="w-full">
            <SortableContext items={[...unplaced]} strategy={rectSortingStrategy}>
              {unplaced.length === 0 ? (
                <span className="px-1 text-muted-foreground text-xs">
                  Drag an element here to hide it.
                </span>
              ) : (
                unplaced.map((element) => (
                  <SlotChip
                    key={element}
                    option={optionOf(element)}
                    required={false}
                    onShow={() => show(element)}
                  />
                ))
              )}
            </SortableContext>
          </DropZone>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeElement === null ? null : <ChipBody option={optionOf(activeElement)} lifted />}
      </DragOverlay>
    </DndContext>
  );
}

function DropZone(props: {
  id: string;
  label: string;
  className?: string;
  /** A control in the top-right corner, on the label line, so it takes no row width. */
  corner?: ReactNode;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: props.id });
  return (
    <div
      ref={setNodeRef}
      aria-label={props.label}
      className={cn(
        "relative flex min-h-10 min-w-0 flex-wrap content-center items-center gap-1 rounded-md border border-dashed px-1.5 pt-4 pb-1.5 transition-colors",
        isOver ? "border-primary bg-accent/60" : "border-border bg-background/40",
        props.className,
      )}
    >
      <span className="pointer-events-none absolute top-0.5 left-1.5 font-medium text-3xs text-muted-foreground uppercase tracking-wide">
        {props.label}
      </span>
      {props.corner ? <span className="absolute top-0.5 right-0.5">{props.corner}</span> : null}
      {props.children}
    </div>
  );
}

function ChipBody<Element extends string>(props: {
  option: SlotLayoutElementOption<Element>;
  lifted?: boolean;
  trailing?: ReactNode;
}) {
  const Icon = props.option.icon;
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md border bg-popover pr-1 pl-0.5 font-medium text-foreground text-xs",
        props.lifted ? "cursor-grabbing shadow-lg" : "cursor-grab",
      )}
    >
      <GripVerticalIcon aria-hidden className="size-3 text-muted-foreground" />
      <Icon className="size-3.5 text-muted-foreground" />
      {props.option.label}
      {props.trailing}
    </span>
  );
}

function SlotChip<Element extends string>(props: {
  option: SlotLayoutElementOption<Element>;
  required: boolean;
  onHide?: () => void;
  onShow?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.option.id,
  });
  const trailing = props.required ? (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" aria-label="Always shown" />}>
        <LockIcon className="size-3 text-muted-foreground" />
      </TooltipTrigger>
      <TooltipPopup side="top">Always shown</TooltipPopup>
    </Tooltip>
  ) : props.onHide ? (
    <button
      type="button"
      aria-label={`Hide ${props.option.label}`}
      className="inline-flex rounded-sm text-muted-foreground hover:text-foreground"
      // Keep the drag sensor from starting on the hide button.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={props.onHide}
    >
      <XIcon className="size-3" />
    </button>
  ) : props.onShow ? (
    <button
      type="button"
      aria-label={`Show ${props.option.label}`}
      className="inline-flex rounded-sm text-muted-foreground hover:text-foreground"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={props.onShow}
    >
      <PlusIcon className="size-3" />
    </button>
  ) : null;
  return (
    <span
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("touch-none outline-none", isDragging && "opacity-40")}
      {...attributes}
      {...listeners}
    >
      <ChipBody option={props.option} trailing={trailing} />
    </span>
  );
}

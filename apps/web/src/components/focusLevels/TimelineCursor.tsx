import {
  type AssistantCitation,
  type ClientSettings,
  MessageId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import {
  type AssistantCitationSourceAnchor,
  captureAssistantTextRange,
} from "~/lib/assistantTextSelection";
import { useClientSettings } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";
import {
  type FocusLevelCommandHandler,
  registerFocusLevelCommands,
} from "./useFocusLevelShortcuts";

/**
 * Fork: a keyboard cursor over the timeline. Depth 0 is a message row. Each deeper depth splits
 * the unit above it: a message into blocks (paragraphs, list items, headings, code blocks, table
 * rows), a block into nested blocks, and a block without nested blocks into sentences, or a code
 * block into lines. The cursor paints with the CSS Custom Highlight API, so it never changes the
 * message DOM, and citing reuses the citation code of a mouse selection.
 *
 * Inside a message, each control is a stop too, after the unit that holds it: a sentence, then its
 * links, then the next sentence. Enter clicks a control. A disclosure, such as a `<details>`
 * summary or a tool call group, is a block: Right opens it, and Left closes it.
 */

const HIGHLIGHT_NAME = "timeline-cursor";
// A trigger with `aria-expanded` and no popup is a disclosure, which shows or hides content in place.
const DISCLOSURE_SELECTOR = "[aria-expanded]:not([aria-haspopup])";
const BLOCK_SELECTOR = `p, li, pre, h1, h2, h3, h4, h5, h6, blockquote, table, tr, ${DISCLOSURE_SELECTOR}`;
const CONTROL_SELECTOR =
  "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1'])";
const ROW_CONTENT_SELECTOR = "[data-assistant-citation-source], [data-user-message-body]";
/** Leaves this much of the timeline above or below the cursor when it scrolls into view. */
const SCROLL_MARGIN_PX = 32;
const MOUNT_WAIT_FRAMES = 12;
const selectKeyboardFocusLevels = (settings: ClientSettings) => settings.keyboardFocusLevels;

interface Unit {
  /** Null for a text unit, a sentence or a code line, which has no deeper units. */
  readonly element: Element | null;
  readonly range: Range;
}

interface Cursor {
  readonly rowId: string;
  /** The unit index at each depth above the current one. */
  readonly parents: ReadonlyArray<number>;
  readonly index: number;
  /** The other end of an extended selection, at the current depth. */
  readonly anchor: number;
  /** The depth that Right and Left chose. Up and Down walk the outline down to this depth. */
  readonly workDepth: number;
  /** A control stop inside the unit at `index`, as an index into its controls. */
  readonly control: number | null;
}

function elementRange(element: Element): Range {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range;
}

/** A range over characters `start` to `end` of the text inside `element`. */
function textRange(element: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start <= offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

function trimmedSpans(text: string, pieces: Iterable<{ index: number; segment: string }>) {
  const spans: Array<[number, number]> = [];
  for (const { index, segment } of pieces) {
    const lead = segment.length - segment.trimStart().length;
    const body = segment.trim();
    if (body.length > 0) spans.push([index + lead, index + lead + body.length]);
  }
  return spans.filter(([start, end]) => end <= text.length && start < end);
}

/**
 * Splits each piece after every colon that a space follows, and keeps the colon with the part
 * before it: "Fix: the key" becomes "Fix:" and "the key". A colon in a URL or a time has no space
 * after it, so it does not split.
 */
function splitAtColons(pieces: Iterable<{ index: number; segment: string }>) {
  const parts: Array<{ index: number; segment: string }> = [];
  for (const { index, segment } of pieces) {
    let start = 0;
    for (let colon = segment.indexOf(": "); colon >= 0; colon = segment.indexOf(": ", start)) {
      parts.push({ index: index + start, segment: segment.slice(start, colon + 1) });
      start = colon + 1;
    }
    parts.push({ index: index + start, segment: segment.slice(start) });
  }
  return parts;
}

function textUnits(element: Element): Unit[] {
  const text = element.textContent ?? "";
  const pieces = element.matches("pre")
    ? text.split("\n").reduce<Array<{ index: number; segment: string }>>((lines, segment) => {
        const previous = lines.at(-1);
        lines.push({ index: previous ? previous.index + previous.segment.length + 1 : 0, segment });
        return lines;
      }, [])
    : splitAtColons(new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text));
  const units: Unit[] = [];
  for (const [start, end] of trimmedSpans(text, pieces)) {
    const range = textRange(element, start, end);
    if (range) units.push({ element: null, range });
  }
  return units.length > 1 ? units : [];
}

/**
 * The blocks inside `root` that no other block inside `root` contains. A closed section can stay
 * mounted but hidden, for find in page, so hidden blocks do not count.
 */
function topLevelBlocks(root: Element): Element[] {
  return Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter((block) => {
    if (!block.checkVisibility()) return false;
    const parentBlock = block.parentElement?.closest(BLOCK_SELECTOR) ?? null;
    return parentBlock === null || parentBlock === root || !root.contains(parentBlock);
  });
}

function childUnits(unit: Unit): Unit[] {
  const element = unit.element;
  if (!element) return [];
  const blocks = element.matches("pre") ? [] : topLevelBlocks(element);
  if (blocks.length > 0)
    return blocks.map((block) => ({ element: block, range: elementRange(block) }));
  return textUnits(element);
}

/** Where a control starts: its first text, so that a sentence that starts with a link holds it. */
function controlStart(control: Element): [Node, number] {
  const text = document.createTreeWalker(control, NodeFilter.SHOW_TEXT).nextNode();
  return text ? [text, 0] : [control, 0];
}

/**
 * The controls whose start is inside `unit`, outermost only. A control without text paints no
 * highlight, so its stop is invisible. Revisit if message content gets icon-only controls.
 */
function unitControls(unit: Unit): HTMLElement[] {
  const common = unit.range.commonAncestorContainer;
  const scope = common instanceof Element ? common : common.parentElement;
  if (!scope) return [];
  return Array.from(scope.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter((control) => {
    const outer = control.parentElement?.closest(CONTROL_SELECTOR);
    return (
      control !== unit.element &&
      (!outer || !scope.contains(outer)) &&
      control.checkVisibility() &&
      unit.range.isPointInRange(...controlStart(control))
    );
  });
}

function rowUnit(row: Element): Unit {
  const content = row.querySelector(ROW_CONTENT_SELECTOR) ?? row;
  return { element: content, range: elementRange(content) };
}

function rangeContains(outer: Range, inner: Range): boolean {
  return (
    outer.compareBoundaryPoints(Range.START_TO_START, inner) <= 0 &&
    outer.compareBoundaryPoints(Range.END_TO_END, inner) >= 0
  );
}

function spanRange(first: Range, last: Range): Range {
  const range = document.createRange();
  range.setStart(first.startContainer, first.startOffset);
  range.setEnd(last.endContainer, last.endOffset);
  return range;
}

function paint(range: Range | null) {
  if (!("highlights" in CSS)) return;
  if (range === null) CSS.highlights.delete(HIGHLIGHT_NAME);
  else CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
}

/** `getScrollableNode` is typed `any`, and some timeline tests render without `HTMLElement`. */
function asHtmlElement(node: unknown): HTMLElement | null {
  return typeof HTMLElement !== "undefined" && node instanceof HTMLElement ? node : null;
}

export function TimelineCursor(props: {
  readonly viewport: HTMLElement | null;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly rows: ReadonlyArray<{ readonly id: string }>;
  readonly threadRef: ScopedThreadRef | null;
  readonly onCite:
    | ((citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor | null) => boolean)
    | undefined;
}) {
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  const enabled = useClientSettings(selectKeyboardFocusLevels);
  // While the setting is on, the scroller takes focus for the timeline level, outside the tab
  // order. Like the selection toolbar, it waits for the viewport.
  useEffect(() => {
    const scroller = asHtmlElement(
      props.viewport ? props.listRef.current?.getScrollableNode() : null,
    );
    if (!scroller || !enabled) return;
    const addedTabIndex = !scroller.hasAttribute("tabindex");
    if (addedTabIndex) scroller.tabIndex = -1;
    scroller.dataset.timelineScroller = "";
    return () => {
      if (addedTabIndex) scroller.removeAttribute("tabindex");
      delete scroller.dataset.timelineScroller;
    };
  }, [props.viewport, props.listRef, enabled]);

  const hasViewport = props.viewport !== null;
  useEffect(() => {
    if (!hasViewport || !enabled) return;
    let cursor: Cursor | null = null;
    const rowIds = () => latest.current.rows.map((row) => row.id);
    const scroller = () => {
      return asHtmlElement(latest.current.listRef.current?.getScrollableNode());
    };
    const rowElement = (rowId: string) =>
      latest.current.viewport?.querySelector(`[data-timeline-row-id="${CSS.escape(rowId)}"]`) ??
      null;
    /** The units at the cursor's depth, or null when its row is not mounted. */
    const siblings = (at: Cursor): Unit[] | null => {
      const row = rowElement(at.rowId);
      if (!row) return null;
      let units = [rowUnit(row)];
      for (const parentIndex of at.parents) {
        const parent = units[parentIndex];
        if (!parent) return null;
        units = childUnits(parent);
      }
      return units;
    };
    /**
     * The control stops of the unit at the cursor. A unit that the walk descends into has none, so
     * each control is a stop once. Message level has none, so Up and Down still skip whole messages.
     */
    const controlsOf = (at: Cursor): HTMLElement[] => {
      if (at.parents.length === 0) return [];
      const unit = siblings(at)?.[at.index];
      if (!unit) return [];
      if (at.parents.length < at.workDepth && childUnits(unit).length > 0) return [];
      return unitControls(unit);
    };
    /** The control that the cursor is on: a control stop, or a unit that is a control itself. */
    const controlTarget = (at: Cursor): HTMLElement | null => {
      if (at.control !== null) return controlsOf(at)[at.control] ?? null;
      const element = siblings(at)?.[at.index]?.element;
      return element instanceof HTMLElement && element.matches(CONTROL_SELECTOR) ? element : null;
    };
    const selectedRange = (at: Cursor): Range | null => {
      if (at.control !== null) {
        const control = controlsOf(at)[at.control];
        return control ? elementRange(control) : null;
      }
      const units = siblings(at);
      if (!units) return null;
      const first = units[Math.min(at.index, at.anchor)];
      const last = units[Math.max(at.index, at.anchor)];
      return first && last ? spanRange(first.range, last.range) : null;
    };
    const reveal = (range: Range) => {
      const node = scroller();
      if (!node) return;
      const area = node.getBoundingClientRect();
      const target = range.getBoundingClientRect();
      if (target.height > area.height - 2 * SCROLL_MARGIN_PX || target.top < area.top) {
        node.scrollTop += target.top - area.top - SCROLL_MARGIN_PX;
      } else if (target.bottom > area.bottom) {
        node.scrollTop += target.bottom - area.bottom + SCROLL_MARGIN_PX;
      }
    };
    const show = (next: Cursor | null) => {
      cursor = next;
      const range = next ? selectedRange(next) : null;
      paint(range);
      if (range) reveal(range);
    };
    /** Scrolls a row that the virtualized list did not mount into the list, then shows it. */
    const showRow = (next: Cursor, framesLeft = MOUNT_WAIT_FRAMES) => {
      if (rowElement(next.rowId)) return show(next);
      const index = rowIds().indexOf(next.rowId);
      if (index < 0 || framesLeft === 0) return;
      if (framesLeft === MOUNT_WAIT_FRAMES)
        void latest.current.listRef.current?.scrollToIndex({
          index,
          viewPosition: 0.5,
          animated: false,
        });
      requestAnimationFrame(() => showRow(next, framesLeft - 1));
    };
    /** The last row on screen, where the cursor starts. */
    const startCursor = (): Cursor | null => {
      const node = scroller();
      const ids = rowIds();
      if (!node || ids.length === 0) return null;
      const bottom = node.getBoundingClientRect().bottom;
      const visible = ids.filter((rowId) => {
        const rect = rowElement(rowId)?.getBoundingClientRect();
        return rect !== undefined && rect.top < bottom;
      });
      const rowId = visible.at(-1) ?? ids.at(-1);
      return rowId
        ? { rowId, parents: [], index: 0, anchor: 0, workDepth: 0, control: null }
        : null;
    };
    const current = (): Cursor | null =>
      cursor && rowIds().includes(cursor.rowId) ? cursor : null;
    /** Cursor keys apply while the scroller itself has focus, not a control inside a row. */
    const active = () => {
      const node = scroller();
      return node !== null && document.activeElement === node;
    };

    // A mouse selection or click in the timeline since the cursor last moved. The next cursor key
    // starts from it, so mouse and keyboard work on the same place.
    let selectionMoved = false;
    const onSelectionChange = () => {
      selectionMoved = true;
    };
    const freshSelection = (): Range | null => {
      const selection = window.getSelection();
      const viewport = latest.current.viewport;
      if (!selectionMoved || !selection || selection.rangeCount !== 1 || !viewport) return null;
      const range = selection.getRangeAt(0);
      return viewport.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
    };
    /** The deepest unit that holds the whole range, at its depth. */
    const cursorAt = (range: Range): Cursor | null => {
      const node = range.startContainer;
      const element = node instanceof Element ? node : node.parentElement;
      const row = element?.closest<HTMLElement>("[data-timeline-row-id]");
      const rowId = row?.dataset.timelineRowId;
      if (!row || !rowId || !rowIds().includes(rowId)) return null;
      const parents: number[] = [];
      let units = [rowUnit(row)];
      let index = 0;
      for (;;) {
        const unit = units[index];
        const children = unit ? childUnits(unit) : [];
        const child = children.findIndex((candidate) => rangeContains(candidate.range, range));
        if (child < 0) break;
        parents.push(index);
        units = children;
        index = child;
      }
      const at: Cursor = {
        rowId,
        parents,
        index,
        anchor: index,
        workDepth: parents.length,
        control: null,
      };
      const control = controlsOf(at).findIndex((candidate) => candidate.contains(element));
      return control >= 0 ? { ...at, control } : at;
    };
    /** Takes over a fresh mouse selection as the cursor, and clears it so only the cursor shows. */
    const adoptSelection = (): Cursor | null => {
      const range = freshSelection();
      selectionMoved = false;
      const at = range ? cursorAt(range) : null;
      if (at) window.getSelection()?.removeAllRanges();
      return at;
    };

    const at0 = (rowId: string, workDepth: number): Cursor => ({
      rowId,
      parents: [],
      index: 0,
      anchor: 0,
      workDepth,
      control: null,
    });
    /**
     * The next unit in document order, never deeper than `workDepth`: 1.1, 1.2, 1.3, 2, 2.1. Past
     * the last unit of a row it moves to the next row. Null at the end of the timeline.
     */
    const walkDown = (at: Cursor): Cursor | null => {
      const unit = siblings(at)?.[at.index];
      if (unit && at.parents.length < at.workDepth && childUnits(unit).length > 0) {
        return { ...at, parents: [...at.parents, at.index], index: 0, anchor: 0 };
      }
      const parents = [...at.parents];
      let index = at.index;
      while (parents.length > 0) {
        const count = siblings({ ...at, parents, index })?.length ?? 0;
        if (index + 1 < count) return { ...at, parents, index: index + 1, anchor: index + 1 };
        index = parents.pop() ?? 0;
      }
      const ids = rowIds();
      const rowId = ids[ids.indexOf(at.rowId) + 1];
      return rowId ? at0(rowId, at.workDepth) : null;
    };
    /** The previous unit in document order, never deeper than `workDepth`: 2.1, 2, 1.3. */
    const walkUp = (at: Cursor): Cursor | null => {
      if (at.parents.length === 0) {
        const ids = rowIds();
        const rowId = ids[ids.indexOf(at.rowId) - 1];
        return rowId ? at0(rowId, at.workDepth) : null;
      }
      if (at.index === 0) {
        const index = at.parents.at(-1) ?? 0;
        return { ...at, parents: at.parents.slice(0, -1), index, anchor: index };
      }
      const parents = [...at.parents];
      let index = at.index - 1;
      while (parents.length < at.workDepth) {
        const unit = siblings({ ...at, parents, index })?.[index];
        const children = unit ? childUnits(unit) : [];
        if (children.length === 0) break;
        parents.push(index);
        index = children.length - 1;
      }
      return { ...at, parents, index, anchor: index };
    };
    /** `walkDown` with the control stops of each unit after the unit. */
    const stepDown = (at: Cursor): Cursor | null => {
      const next = at.control === null ? 0 : at.control + 1;
      if (next < controlsOf(at).length) return { ...at, control: next };
      return walkDown({ ...at, control: null });
    };
    /** `walkUp` with the control stops. Back into a unit, the cursor lands on its last control. */
    const stepUp = (at: Cursor): Cursor | null => {
      if (at.control !== null) return { ...at, control: at.control > 0 ? at.control - 1 : null };
      const previous = walkUp(at);
      const count = previous ? controlsOf(previous).length : 0;
      return previous && count > 0 ? { ...previous, control: count - 1 } : previous;
    };
    const showStep = (from: Cursor, next: Cursor | null) => {
      if (!next) return;
      if (next.rowId === from.rowId) show(next);
      else showRow(next);
    };
    const move =
      (direction: 1 | -1, extend: boolean): FocusLevelCommandHandler =>
      () => {
        if (!active()) return false;
        const at = adoptSelection() ?? current();
        if (!at) {
          const start = startCursor();
          if (start) show(start);
          return true;
        }
        // Shift extends the selection over siblings only, so it never spans two parents.
        if (extend && at.parents.length > 0) {
          const count = siblings(at)?.length ?? 0;
          const index = Math.max(0, Math.min(count - 1, at.index + direction));
          show({ ...at, index, control: null });
          return true;
        }
        showStep(at, direction === 1 ? stepDown(at) : stepUp(at));
        return true;
      };
    const cite =
      (withNote: boolean): FocusLevelCommandHandler =>
      () => {
        if (!active()) return false;
        // A mouse selection is cited exactly as selected; the cursor then continues from it.
        const selected = freshSelection();
        const fromMouse = selected && !selected.collapsed ? selected : null;
        const at = adoptSelection() ?? current();
        if (at) show(at);
        // On a control, Enter clicks it: a link opens, a section opens or closes, a button runs.
        const target = !fromMouse && at ? controlTarget(at) : null;
        if (target) {
          target.click();
          return true;
        }
        const viewport = latest.current.viewport;
        const { threadRef, onCite } = latest.current;
        const range = fromMouse ?? (at ? selectedRange(at) : null);
        if (!range || !viewport || !threadRef || !onCite) return true;
        const captured = captureAssistantTextRange(viewport, range);
        const messageId = captured?.source.dataset.assistantCitationSource;
        if (!captured || !messageId) {
          toastManager.add({ type: "warning", title: "Only assistant text can be cited" });
          return true;
        }
        const citation: AssistantCitation = {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        };
        const node = scroller();
        const cited = onCite(
          citation,
          withNote ? { source: captured.source, range: captured.range, viewport } : null,
        );
        // The composer takes focus on insert. A plain cite returns it, so the next part can be cited.
        if (cited && !withNote && node) {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => node.focus({ preventScroll: true })),
          );
        }
        return true;
      };
    const onFocusOut = (event: FocusEvent) => {
      if (event.target === scroller()) paint(null);
    };
    // A click in the timeline also focuses the scroller, so focus repaints the cursor without
    // scrolling to it. Scrolling there would undo the user's own scroll.
    const onFocusIn = (event: FocusEvent) => {
      const at = current();
      if (event.target === scroller() && at) paint(selectedRange(at));
    };
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("selectionchange", onSelectionChange);
    const unregister = registerFocusLevelCommands({
      "timeline.previous": move(-1, false),
      "timeline.next": move(1, false),
      "timeline.extendUp": move(-1, true),
      "timeline.extendDown": move(1, true),
      "timeline.deeper": (event) => {
        if (!active()) return false;
        const at = adoptSelection() ?? current();
        if (!at) return move(1, false)(event);
        const target = controlTarget(at);
        if (target?.matches(DISCLOSURE_SELECTOR)) {
          if (target.getAttribute("aria-expanded") === "false") target.click();
          else showStep(at, stepDown(at));
          return true;
        }
        if (at.control !== null) return true;
        const units = siblings(at);
        const unit = units?.[at.index];
        if (unit && childUnits(unit).length > 0) {
          show({
            rowId: at.rowId,
            parents: [...at.parents, at.index],
            index: 0,
            anchor: 0,
            workDepth: at.parents.length + 1,
            control: null,
          });
        }
        return true;
      },
      "timeline.shallower": () => {
        if (!active()) return false;
        const at = adoptSelection() ?? current();
        const target = at ? controlTarget(at) : null;
        if (
          target?.matches(DISCLOSURE_SELECTOR) &&
          target.getAttribute("aria-expanded") === "true"
        ) {
          target.click();
          return true;
        }
        if (at && at.control !== null) {
          show({ ...at, control: null });
          return true;
        }
        const parentIndex = at?.parents.at(-1);
        if (at && parentIndex !== undefined) {
          show({
            rowId: at.rowId,
            parents: at.parents.slice(0, -1),
            index: parentIndex,
            anchor: parentIndex,
            workDepth: at.parents.length - 1,
            control: null,
          });
        }
        return true;
      },
      // Escape on a control that has focus returns to the cursor, on that control. From the cursor,
      // it leaves a control stop, then climbs one depth at a time, then out of the timeline.
      "focus.up": () => {
        if (!active()) {
          const node = scroller();
          const focused = document.activeElement;
          const viewport = latest.current.viewport;
          if (!node || !viewport || !(focused instanceof HTMLElement)) return false;
          if (!viewport.contains(focused)) return false;
          cursor = cursorAt(elementRange(focused)) ?? current();
          node.focus({ preventScroll: true });
          return true;
        }
        const at = current();
        if (at && at.control !== null) {
          show({ ...at, control: null });
          return true;
        }
        const parentIndex = at?.parents.at(-1);
        if (at && parentIndex !== undefined) {
          show({
            rowId: at.rowId,
            parents: at.parents.slice(0, -1),
            index: parentIndex,
            anchor: parentIndex,
            workDepth: at.parents.length - 1,
            control: null,
          });
          return true;
        }
        show(null);
        return false;
      },
      "timeline.cite": cite(false),
      "timeline.citeWithNote": cite(true),
      "timeline.jumpToLatest": () => {
        if (!active()) return false;
        show(null);
        void latest.current.listRef.current?.scrollToEnd({ animated: true });
        return true;
      },
    });
    return () => {
      unregister();
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("selectionchange", onSelectionChange);
      paint(null);
    };
  }, [hasViewport, enabled]);

  return null;
}

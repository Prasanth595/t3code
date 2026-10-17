import { type AssistantCitation, MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import {
  type AssistantCitationSourceAnchor,
  captureAssistantTextRange,
} from "~/lib/assistantTextSelection";
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
 */

const HIGHLIGHT_NAME = "timeline-cursor";
const BLOCK_SELECTOR = "p, li, pre, h1, h2, h3, h4, h5, h6, blockquote, table, tr";
const ROW_CONTENT_SELECTOR = "[data-assistant-citation-source], [data-user-message-body]";
/** Leaves this much of the timeline above or below the cursor when it scrolls into view. */
const SCROLL_MARGIN_PX = 32;
const MOUNT_WAIT_FRAMES = 12;

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

function textUnits(element: Element): Unit[] {
  const text = element.textContent ?? "";
  const pieces = element.matches("pre")
    ? text.split("\n").reduce<Array<{ index: number; segment: string }>>((lines, segment) => {
        const previous = lines.at(-1);
        lines.push({ index: previous ? previous.index + previous.segment.length + 1 : 0, segment });
        return lines;
      }, [])
    : new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text);
  const units: Unit[] = [];
  for (const [start, end] of trimmedSpans(text, pieces)) {
    const range = textRange(element, start, end);
    if (range) units.push({ element: null, range });
  }
  return units.length > 1 ? units : [];
}

/** The blocks inside `root` that no other block inside `root` contains. */
function topLevelBlocks(root: Element): Element[] {
  return Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter((block) => {
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

function rowUnit(row: Element): Unit {
  const content = row.querySelector(ROW_CONTENT_SELECTOR) ?? row;
  return { element: content, range: elementRange(content) };
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

  // The scroller takes focus for the timeline level. It is not in the tab order.
  useEffect(() => {
    const scroller = props.listRef.current?.getScrollableNode();
    if (!(scroller instanceof HTMLElement)) return;
    if (scroller.tabIndex !== 0) scroller.tabIndex = -1;
    scroller.dataset.timelineScroller = "";
  });

  useEffect(() => {
    let cursor: Cursor | null = null;
    const rowIds = () => latest.current.rows.map((row) => row.id);
    const scroller = () => {
      const node = latest.current.listRef.current?.getScrollableNode();
      return node instanceof HTMLElement ? node : null;
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
    const selectedRange = (at: Cursor): Range | null => {
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
      return rowId ? { rowId, parents: [], index: 0, anchor: 0 } : null;
    };
    const current = (): Cursor | null =>
      cursor && rowIds().includes(cursor.rowId) ? cursor : null;
    /** Cursor keys apply while the scroller itself has focus, not a control inside a row. */
    const active = () => {
      const node = scroller();
      return node !== null && document.activeElement === node;
    };

    const move =
      (direction: 1 | -1, extend: boolean): FocusLevelCommandHandler =>
      () => {
        if (!active()) return false;
        const at = current();
        if (!at) {
          const start = startCursor();
          if (start) show(start);
          return true;
        }
        if (at.parents.length === 0) {
          const ids = rowIds();
          const rowId = ids[ids.indexOf(at.rowId) + direction];
          if (rowId) showRow({ rowId, parents: [], index: 0, anchor: 0 });
          return true;
        }
        const count = siblings(at)?.length ?? 0;
        const index = Math.max(0, Math.min(count - 1, at.index + direction));
        show({ ...at, index, anchor: extend ? at.anchor : index });
        return true;
      };
    const cite =
      (withNote: boolean): FocusLevelCommandHandler =>
      () => {
        if (!active()) return false;
        const at = current();
        const viewport = latest.current.viewport;
        const { threadRef, onCite } = latest.current;
        const range = at ? selectedRange(at) : null;
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
        onCite(
          citation,
          withNote ? { source: captured.source, range: captured.range, viewport } : null,
        );
        return true;
      };
    const onFocusOut = (event: FocusEvent) => {
      if (event.target === scroller()) paint(null);
    };
    const onFocusIn = (event: FocusEvent) => {
      const at = current();
      if (event.target === scroller() && at) show(at);
    };
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("focusin", onFocusIn);
    const unregister = registerFocusLevelCommands({
      "timeline.previous": move(-1, false),
      "timeline.next": move(1, false),
      "timeline.extendUp": move(-1, true),
      "timeline.extendDown": move(1, true),
      "timeline.deeper": (event) => {
        if (!active()) return false;
        const at = current();
        if (!at) return move(1, false)(event);
        const units = siblings(at);
        const unit = units?.[at.index];
        if (unit && childUnits(unit).length > 0) {
          show({ rowId: at.rowId, parents: [...at.parents, at.index], index: 0, anchor: 0 });
        }
        return true;
      },
      "timeline.shallower": () => {
        if (!active()) return false;
        const at = current();
        const parentIndex = at?.parents.at(-1);
        if (at && parentIndex !== undefined) {
          show({
            rowId: at.rowId,
            parents: at.parents.slice(0, -1),
            index: parentIndex,
            anchor: parentIndex,
          });
        }
        return true;
      },
      // Escape climbs out of the cursor one depth at a time, then out of the timeline.
      "focus.up": () => {
        if (!active()) return false;
        const at = current();
        const parentIndex = at?.parents.at(-1);
        if (at && parentIndex !== undefined) {
          show({
            rowId: at.rowId,
            parents: at.parents.slice(0, -1),
            index: parentIndex,
            anchor: parentIndex,
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
      paint(null);
    };
  }, []);

  return null;
}

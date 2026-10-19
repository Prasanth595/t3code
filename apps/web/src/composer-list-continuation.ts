import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";

export interface ComposerListEdit {
  start: number;
  end: number;
  replacement: string;
  /** Expanded caret after the edit; defaults to the end of the replacement. */
  cursor?: number;
}

type ListMarker =
  | { kind: "ordered"; indent: string; numberText: string; delimiter: "." | ")"; space: string }
  | { kind: "task"; indent: string; space: string }
  | { kind: "bullet"; indent: string; bullet: string; space: string };

function parseListMarker(line: string): { marker: ListMarker; markerEnd: number } | null {
  const indent = line.match(/^[ \t]*/)?.[0] ?? "";
  const rest = line.slice(indent.length);
  const ordered = rest.match(/^(\d+)([.)])((?:[ \t]+)|\s*$)/);
  if (ordered && ordered[1] !== undefined && ordered[2] !== undefined) {
    return {
      marker: {
        kind: "ordered",
        indent,
        numberText: ordered[1],
        delimiter: ordered[2] === ")" ? ")" : ".",
        space: ordered[3] ?? "",
      },
      markerEnd: indent.length + ordered[0].length,
    };
  }
  const task = rest.match(/^-\s\[[ xX]\]((?:[ \t]+)|\s*$)/);
  if (task) {
    return {
      marker: { kind: "task", indent, space: task[1] ?? "" },
      markerEnd: indent.length + task[0].length,
    };
  }
  const bullet = rest.match(/^([-*+])((?:[ \t]+)|\s*$)/);
  if (bullet && bullet[1] !== undefined) {
    return {
      marker: { kind: "bullet", indent, bullet: bullet[1], space: bullet[2] ?? "" },
      markerEnd: indent.length + bullet[0].length,
    };
  }
  return null;
}

export function nextOrderedMarkerText(marker: string): string {
  const numberText = marker.slice(0, -1);
  const delimiter = marker.slice(-1);
  const number = Number.parseInt(numberText, 10);
  const next = Number.isSafeInteger(number)
    ? String(number + 1).padStart(numberText.length, "0")
    : numberText;
  return `${next}${delimiter}`;
}

function nextMarkerText(marker: ListMarker): string {
  if (marker.kind === "ordered") {
    return `${marker.indent}${nextOrderedMarkerText(`${marker.numberText}${marker.delimiter}`)} `;
  }
  if (marker.kind === "task") {
    return `${marker.indent}- [ ] `;
  }
  return `${marker.indent}${marker.bullet} `;
}

function segmentSource(
  segment: ReturnType<typeof splitPromptIntoComposerSegments>[number],
): string {
  if (segment.type === "text") return segment.text;
  return segment.source;
}

function isInsideInlineToken(value: string, cursor: number): boolean {
  let offset = 0;
  for (const segment of splitPromptIntoComposerSegments(value)) {
    const end = offset + segmentSource(segment).length;
    if (segment.type !== "text" && cursor > offset && cursor < end) return true;
    offset = end;
  }
  return false;
}

function currentLine(value: string, cursor: number) {
  const start = value.lastIndexOf("\n", cursor - 1) + 1;
  const endIndex = value.indexOf("\n", cursor);
  const end = endIndex === -1 ? value.length : endIndex;
  return { start, end, text: value.slice(start, end) };
}

function* listMarkersAbove(value: string, start: number) {
  while (start > 0) {
    const previous = currentLine(value, start - 1);
    const parsed = parseListMarker(previous.text);
    if (!parsed) return;
    yield parsed.marker;
    start = previous.start;
  }
}

export function listContinuationForEnter(value: string, cursor: number): ComposerListEdit | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > value.length) return null;
  const line = currentLine(value, cursor);
  const parsed = parseListMarker(line.text);
  if (!parsed) return null;
  const markerEnd = line.start + parsed.markerEnd;
  if (cursor < markerEnd) return null;
  if (isInsideInlineToken(value, cursor)) return null;
  if (value.slice(markerEnd, line.end).trim() === "") {
    let parent: ListMarker | undefined;
    const indent = parsed.marker.indent;
    if (indent !== "") {
      for (const above of listMarkersAbove(value, line.start)) {
        if (above.indent.length < indent.length && indent.startsWith(above.indent)) {
          parent = above;
          break;
        }
      }
    }
    return {
      start: line.start,
      end: Math.max(cursor, markerEnd),
      replacement: parent ? nextMarkerText(parent) : "",
    };
  }
  return {
    start: cursor,
    end: cursor,
    replacement: `\n${nextMarkerText(parsed.marker)}`,
  };
}

export function listIndentForTab(
  value: string,
  start: number,
  end: number,
): ComposerListEdit | null {
  if (!Number.isInteger(start) || start !== end || start < 0 || start > value.length) return null;
  const line = currentLine(value, start);
  const parsed = parseListMarker(line.text);
  if (!parsed || isInsideInlineToken(value, start)) return null;
  const marker = parsed.marker;
  let lastChild: ListMarker | undefined;
  for (const above of listMarkersAbove(value, line.start)) {
    if (above.indent.length > marker.indent.length && above.indent.startsWith(marker.indent)) {
      if (!lastChild || above.indent.length < lastChild.indent.length) lastChild = above;
      continue;
    }
    if (above.indent !== marker.indent) break;

    // Markdown children must reach the parent's content column. A task's box is content.
    const markerWidth = above.kind === "ordered" ? above.numberText.length + 1 : 1;
    const space = above.space.length;
    const childWidth =
      above.kind === "task" ? 2 : markerWidth + (space >= 1 && space <= 4 ? space : 1);
    const indent = lastChild?.indent ?? above.indent + " ".repeat(childWidth);
    const sibling =
      marker.kind === "ordered" &&
      lastChild?.kind === "ordered" &&
      lastChild.delimiter === marker.delimiter
        ? lastChild
        : null;
    const numberText = sibling
      ? nextOrderedMarkerText(sibling.numberText + sibling.delimiter).slice(0, -1)
      : "1";
    const editEnd =
      line.start +
      marker.indent.length +
      (marker.kind === "ordered" ? marker.numberText.length : 0);
    const replacement = indent + (marker.kind === "ordered" ? numberText : "");
    const shift = replacement.length - (editEnd - line.start);
    return {
      start: line.start,
      end: editEnd,
      replacement,
      cursor: start >= editEnd ? start + shift : line.start + indent.length,
    };
  }
  return { start: line.start, end: line.start, replacement: "  ", cursor: start + 2 };
}

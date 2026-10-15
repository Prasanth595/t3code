interface ListMarker {
  readonly column: number;
  readonly contentColumn: number;
  readonly number: number;
}

interface LinePrefix {
  readonly quoteDepth: number;
  /** Whether any bullet or ordered-list marker opens the line. */
  readonly hasListMarker: boolean;
  readonly orderedMarkers: ReadonlyArray<ListMarker>;
  /** Column where the innermost container's content starts. */
  readonly contentColumn: number;
  readonly restColumn: number;
  readonly rest: string;
}

const isBlank = (char: string | undefined) => char === " " || char === "\t";
const isDigit = (char: string | undefined) => char !== undefined && char >= "0" && char <= "9";

// Walks the quote, bullet, and ordered-list markers at the start of a line,
// with tab stops of 4. Content starts 1-4 columns after a marker, as in CommonMark.
function readLinePrefix(line: string): LinePrefix {
  const orderedMarkers: ListMarker[] = [];
  let quoteDepth = 0;
  let hasListMarker = false;
  let index = 0;
  let column = 0;
  let contentColumn = 0;
  // Set after a list marker until the following spaces fix its content column.
  let pending: { markerEnd: number; number: number | null; column: number } | null = null;
  for (;;) {
    while (isBlank(line[index])) {
      column = line[index] === "\t" ? column + 4 - (column % 4) : column + 1;
      index += 1;
    }
    if (pending) {
      const gap = column - pending.markerEnd;
      contentColumn = gap >= 1 && gap <= 4 && index < line.length ? column : pending.markerEnd + 1;
      if (pending.number !== null) {
        orderedMarkers.push({ column: pending.column, contentColumn, number: pending.number });
      }
      pending = null;
    }
    const markerColumn = column;
    const char = line[index];
    if (char === ">") {
      quoteDepth += 1;
      index += 1;
      column += 1;
      contentColumn = column + (isBlank(line[index]) ? 1 : 0);
      continue;
    }
    if ((char === "-" || char === "+" || char === "*") && isBlank(line[index + 1])) {
      hasListMarker = true;
      index += 1;
      column += 1;
      pending = { markerEnd: column, number: null, column: markerColumn };
      continue;
    }
    let digitsEnd = index;
    while (digitsEnd - index < 9 && isDigit(line[digitsEnd])) digitsEnd += 1;
    const delimiter = line[digitsEnd];
    const after = line[digitsEnd + 1];
    if (
      digitsEnd > index &&
      (delimiter === "." || delimiter === ")") &&
      (isBlank(after) || after === undefined || after === "\r")
    ) {
      hasListMarker = true;
      column += digitsEnd + 1 - index;
      const number = Number(line.slice(index, digitsEnd));
      index = digitsEnd + 1;
      pending = { markerEnd: column, number, column: markerColumn };
      continue;
    }
    return {
      quoteDepth,
      hasListMarker,
      orderedMarkers,
      contentColumn,
      restColumn: column,
      rest: line.slice(index),
    };
  }
}

const FENCE_OPENER = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSER = /^(`{3,}|~{3,})[ \t\r]*$/;

/**
 * Digit count of the widest number the renderer could draw for an ordered list
 * in `markdown`, when that is three or more digits; otherwise 0.
 *
 * Lists number their items up from the first marker, so each item counts as at
 * least one more than the previous item of its list. This is one cheap pass
 * while a reply streams. When a line is ambiguous it keeps counting, so it can
 * overestimate (a slightly wider gutter) but should not clip a number.
 */
export function wideOrderedListMarkerDigits(markdown: string): number {
  // Open ordered lists, outermost first.
  let lists: Array<{ contentColumn: number; number: number }> = [];
  let fence: { char: string; length: number; quoteDepth: number; column: number } | null = null;
  let afterBlankLine = false;
  let widest = 0;
  for (const line of markdown.split("\n")) {
    const prefix = readLinePrefix(line);
    if (fence !== null) {
      // A fence ends at its closer, or when the quote holding it ends.
      if (prefix.quoteDepth >= fence.quoteDepth) {
        const closer = FENCE_CLOSER.exec(prefix.rest)?.[1];
        if (
          !prefix.hasListMarker &&
          prefix.restColumn - fence.column <= 3 &&
          closer?.[0] === fence.char &&
          closer.length >= fence.length
        ) {
          fence = null;
        }
        continue;
      }
      fence = null;
    }
    for (const marker of prefix.orderedMarkers) {
      // Leave lists whose items this marker sits outside of.
      while (lists.length >= 2 && marker.column < lists[lists.length - 2]!.contentColumn) {
        lists.pop();
      }
      const list = lists.at(-1);
      if (list && marker.column < list.contentColumn) {
        list.number = Math.max(marker.number, list.number + 1);
        list.contentColumn = marker.contentColumn;
      } else {
        lists.push({ contentColumn: marker.contentColumn, number: marker.number });
      }
      widest = Math.max(widest, lists.at(-1)!.number);
    }
    const opener = FENCE_OPENER.exec(prefix.rest);
    if (
      opener &&
      prefix.restColumn - prefix.contentColumn <= 3 &&
      !(opener[1]!.startsWith("`") && opener[2]!.includes("`"))
    ) {
      fence = {
        char: opener[1]![0]!,
        length: opener[1]!.length,
        quoteDepth: prefix.quoteDepth,
        column: prefix.restColumn,
      };
    } else if (afterBlankLine && !prefix.hasListMarker && /^[^ \t\r]/.test(line)) {
      // Unindented text after a blank line cannot belong to any list item.
      lists = [];
    }
    afterBlankLine = line.trim() === "";
  }
  const digits = String(widest).length;
  return digits >= 3 ? digits : 0;
}

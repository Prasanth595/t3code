// A line the renderer could read as an ordered-list item, including one nested
// after quote or list markers. Group 1 is everything before the number, so its
// length tells nested lists apart. Indented code also matches; that only widens.
// Each repeat starts with a marker or `>`, which keeps matching linear.
const ORDERED_MARKER_LINE =
  /^([ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+(?:>[ \t>]*)?)*)(\d{1,9})[.)](?:[ \t\r]|$)/;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Digit count of the widest number the renderer could draw for an ordered list
 * in `markdown`, when that is three or more digits; otherwise 0.
 *
 * Lists number their items up from the first marker, so each item counts as at
 * least one more than the previous item of its list. This is one cheap pass
 * while a reply streams. When a line is ambiguous it keeps counting, so it can
 * overestimate (a slightly wider gutter) but never clip a number.
 */
export function wideOrderedListMarkerDigits(markdown: string): number {
  // Last number per open list, keyed by the marker's column.
  const lists = new Map<number, number>();
  let openFence: string | null = null;
  let afterBlankLine = false;
  let widest = 0;
  for (const line of markdown.split("\n")) {
    const fence = CODE_FENCE.exec(line)?.[1];
    if (openFence !== null) {
      if (fence && fence[0] === openFence[0] && fence.length >= openFence.length) openFence = null;
      continue;
    }
    if (fence) {
      openFence = fence;
      continue;
    }
    const marker = ORDERED_MARKER_LINE.exec(line);
    if (marker) {
      const column = marker[1]!.length;
      for (const key of lists.keys()) if (key > column) lists.delete(key);
      const number = Math.max(Number(marker[2]), (lists.get(column) ?? -1) + 1);
      lists.set(column, number);
      widest = Math.max(widest, number);
    } else if (afterBlankLine && /^[^ \t\r]/.test(line)) {
      // Unindented text after a blank line cannot belong to any list item.
      lists.clear();
    }
    afterBlankLine = line.trim() === "";
  }
  const digits = String(widest).length;
  return digits >= 3 ? digits : 0;
}

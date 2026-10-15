// A line that may start an ordered-list item, including one nested after quote
// or list markers. Group 1 holds the container markers before the last number,
// which can include outer numbers. Each repeat starts with a marker or `>`,
// which keeps matching linear.
const ORDERED_MARKER_LINE =
  /^([ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+(?:>[ \t>]*)?)*)(\d{1,9})[.)](?:[ \t\r]|$)/;
const PREFIX_NUMBER = /(\d{1,9})[.)]/g;
export function wideOrderedListMarkerDigits(markdown: string): number {
  let widest = 0;
  let items = 0;
  for (const line of markdown.split("\n")) {
    const marker = ORDERED_MARKER_LINE.exec(line);
    if (!marker) continue;
    items += 1;
    widest = Math.max(widest, Number(marker[2]));
    for (const outer of marker[1]!.matchAll(PREFIX_NUMBER)) {
      widest = Math.max(widest, Number(outer[1]));
    }
  }
  // The renderer increments repeated `1.` markers. Counting every matched item
  // may over-size messages with many separate lists, but it cannot clip them.
  const digits = String(Math.max(widest, items)).length;
  return digits >= 3 ? digits : 0;
}

// Matches ordered-list markers, including nested and quoted ones. Lines inside
// code blocks can match too; that only widens the gutter, it never clips.
const ORDERED_LIST_MARKER = /^[ \t>]*(\d{1,9})[.)](?=[ \t]|$)/gm;

/**
 * Digit count of the largest ordered-list number written in `markdown`, or 0
 * when it has none. Uses the numbers as written, which is how agents number
 * long lists.
 */
export function widestOrderedListMarkerDigits(markdown: string): number {
  let widest = 0;
  for (const match of markdown.matchAll(ORDERED_LIST_MARKER)) {
    widest = Math.max(widest, String(Number(match[1])).length);
  }
  return widest;
}

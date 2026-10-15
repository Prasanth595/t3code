// A line that may start an ordered-list item, including one nested after quote
// or list markers. Group 1 is everything before the number. Each repeat starts
// with a marker or `>`, which keeps matching linear.
const ORDERED_MARKER_LINE =
  /^([ \t>]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+(?:>[ \t>]*)?)*)(\d{1,9})[.)](?:[ \t\r]|$)/;
const TOP_LEVEL_PREFIX = /^ {0,3}$/;

/**
 * Digit count of the widest ordered-list number in `markdown`, when that is
 * three or more digits; otherwise 0.
 *
 * Agents write their list numbers out, so the largest written number covers
 * normal replies. Counting top-level items also covers lists the renderer
 * numbers itself, such as `1.` on every line. Code blocks are not skipped; a
 * stray match there only widens the gutter.
 */
export function wideOrderedListMarkerDigits(markdown: string): number {
  let widest = 0;
  let topLevelItems = 0;
  for (const line of markdown.split("\n")) {
    const marker = ORDERED_MARKER_LINE.exec(line);
    if (!marker) continue;
    widest = Math.max(widest, Number(marker[2]));
    if (TOP_LEVEL_PREFIX.test(marker[1]!)) topLevelItems += 1;
  }
  const digits = String(Math.max(widest, topLevelItems)).length;
  return digits >= 3 ? digits : 0;
}

import type { Root, RootContent } from "mdast";

import { parseMarkdownDocument } from "./markdownDocument";

// Anything that could be an ordered-list marker, anywhere on a line. Matching
// too much only costs a parse below; it never changes the result.
const POSSIBLE_ORDERED_MARKER = /(\d{1,9})[.)](?=[ \t\r\n]|$)/g;

function widestOrderedListNumber(node: Root | RootContent): number {
  let widest =
    node.type === "list" && node.ordered ? (node.start ?? 1) + node.children.length - 1 : 0;
  if ("children" in node) {
    for (const child of node.children) widest = Math.max(widest, widestOrderedListNumber(child));
  }
  return widest;
}

/**
 * Digit count of the widest number the renderer draws for an ordered list in
 * `markdown`, when it has three or more digits; otherwise 0. Lists number
 * their items from the first marker, so the written numbers alone are not
 * enough.
 */
export function wideOrderedListMarkerDigits(markdown: string): number {
  let largestMarker = 0;
  let markerCount = 0;
  for (const match of markdown.matchAll(POSSIBLE_ORDERED_MARKER)) {
    largestMarker = Math.max(largestMarker, Number(match[1]));
    markerCount += 1;
  }
  // No list can count past its first marker plus its item count.
  if (largestMarker + markerCount <= 100) return 0;
  const digits = String(widestOrderedListNumber(parseMarkdownDocument(markdown))).length;
  return digits >= 3 ? digits : 0;
}

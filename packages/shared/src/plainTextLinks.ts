/**
 * Splits plain text into prose and bare `http(s)` URLs, so surfaces that show
 * agent text without a markdown renderer (such as a pending question) can
 * still make the links in it tappable.
 */
export type PlainTextLinkSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "url"; readonly url: string };

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
// Sentence punctuation and markdown emphasis that commonly trail a URL.
const TRAILING_PUNCTUATION = /[.,;:!?*_~]$/u;
const CLOSING_BRACKETS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const count = (text: string, character: string) => text.split(character).length - 1;

function trimUrl(candidate: string): string {
  let url = candidate;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    if (TRAILING_PUNCTUATION.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opening = CLOSING_BRACKETS[last];
    // Keep a closing bracket the URL itself opened, like a Wikipedia path.
    if (opening !== undefined && count(url, opening) < count(url, last)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

export function splitPlainTextLinks(text: string): ReadonlyArray<PlainTextLinkSegment> {
  const segments: PlainTextLinkSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    // A bare scheme with nothing after it is not a link.
    if (!/^https?:\/\/[^/]/iu.test(url)) continue;
    if (match.index > cursor)
      segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    segments.push({ kind: "url", url });
    cursor = match.index + url.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}

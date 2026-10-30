import type { Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type TextDirection = "ltr" | "rtl";

// Hebrew through Arabic Extended-A, their presentation forms, and the
// supplementary right-to-left blocks.
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;

/**
 * `dir="auto"` misreads Arabic prose that opens with an English term.
 * Count words so mixed prose follows its main language; break ties with the first word.
 */
export function textDirection(text: string): TextDirection | undefined {
  let rtlWords = 0;
  let ltrWords = 0;
  let first: TextDirection | undefined;
  for (const word of text.split(/\s+/)) {
    const letter = LETTER.exec(word)?.[0];
    if (!letter) continue;
    const direction = RTL_LETTER.test(letter) ? "rtl" : "ltr";
    first ??= direction;
    if (direction === "rtl") rtlWords += 1;
    else ltrWords += 1;
  }
  if (rtlWords === ltrWords) return first;
  return rtlWords > ltrWords ? "rtl" : "ltr";
}

const markdownParser = unified().use(remarkParse).freeze();

export function markdownCodeParts(markdown: string) {
  const parts: Array<{ text: string; code: boolean; start: number }> = [];
  let offset = 0;
  const visit = (node: Root | RootContent): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      if (start > offset) {
        parts.push({ text: markdown.slice(offset, start), code: false, start: offset });
      }
      parts.push({ text: markdown.slice(start, end), code: true, start });
      offset = end;
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  visit(markdownParser.parse(markdown));
  if (offset < markdown.length) {
    parts.push({ text: markdown.slice(offset), code: false, start: offset });
  }
  return parts;
}

function proseDirection(parts: ReadonlyArray<{ text: string; code: boolean }>) {
  const prose = parts
    .filter((part) => !part.code)
    .map((part) => part.text)
    .join(" ");
  return textDirection(prose.replace(/https?:\/\/\S+/g, " "));
}

export function markdownProseDirection(...fields: ReadonlyArray<string>) {
  return proseDirection(fields.flatMap(markdownCodeParts));
}

export function markdownPreview(markdown: string, maxChars: number) {
  let previousSpace = false;
  const normalized = [];
  for (const part of markdownCodeParts(markdown)) {
    let text = part.text.replace(/\s+/g, " ");
    if (previousSpace && text.startsWith(" ")) text = text.slice(1);
    if (text.length > 0) previousSpace = text.endsWith(" ");
    normalized.push({ ...part, text });
  }
  const length = normalized.reduce((total, part) => total + part.text.length, 0);
  const parts = [];
  let rendered = 0;
  for (const part of normalized) {
    if (rendered >= maxChars) break;
    let text = part.text.slice(0, maxChars - rendered);
    rendered += text.length;
    if (rendered === maxChars && length > maxChars) text += "…";
    parts.push({ ...part, text });
  }
  return { parts, direction: proseDirection(parts) };
}

export function markdownWithDirection(markdown: string, direction: TextDirection | undefined) {
  if (!direction) return markdown;
  const offsets: number[] = [];
  const visit = (node: Root | RootContent): void => {
    if (node.type === "paragraph" || node.type === "heading") {
      const offset = node.children[0]?.position?.start.offset;
      if (offset !== undefined) offsets.push(offset);
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(markdownParser.parse(markdown));
  const mark = direction === "rtl" ? "\u200f" : "\u200e";
  for (const offset of offsets.reverse()) {
    markdown = markdown.slice(0, offset) + mark + markdown.slice(offset);
  }
  return markdown;
}

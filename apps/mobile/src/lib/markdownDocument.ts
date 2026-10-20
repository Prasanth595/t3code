import type { Root, RootContent } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);
export type MarkdownNode = Root | RootContent;

function decodeCodePoint(codePoint: number, entity: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) {
        return decodeCodePoint(Number.parseInt(decimal, 10), entity);
      }
      if (hexadecimal) {
        return decodeCodePoint(Number.parseInt(hexadecimal, 16), entity);
      }
      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&apos;":
          return "'";
        case "&gt;":
          return ">";
        case "&lt;":
          return "<";
        case "&nbsp;":
          return "\u00a0";
        case "&quot;":
          return '"';
        default:
          return entity;
      }
    },
  );
}

const HTML_TAG = /<!--[\s\S]*?-->|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi;

function attribute(tag: string, name: string): string | null {
  const attributes = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(attributes)) {
    if (match[1]?.toLowerCase() === name) {
      return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
  }
  return null;
}

function markdownDestination(url: string): string {
  return `<${url.replace(/&/g, "\\&").replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\n/g, "")}>`;
}

const ANCHOR_TAG = /^<\/?a[\s/>]/i;

/**
 * Pairs `<a>` tags in order. Only a closed anchor with an http(s) or mailto href becomes a
 * Markdown link; any other anchor keeps its text unlinked.
 */
function anchorMarkdown(tags: readonly string[]): string[] {
  const replacements = tags.map(() => "");
  const open: Array<{ index: number; href: string | undefined }> = [];
  tags.forEach((tag, index) => {
    if (tag[1] !== "/") {
      const href = attribute(tag, "href")?.trim();
      open.push({ index, href: href && /^(?:https?|mailto):/i.test(href) ? href : undefined });
      return;
    }
    const opening = open.pop();
    if (!opening?.href) return;
    replacements[opening.index] = "[";
    replacements[index] = `](${markdownDestination(opening.href)})`;
  });
  return replacements;
}

function markdownHtmlTags(content: string): RegExpExecArray[] {
  // An HTML block such as <details> can also contain Markdown fences and code spans.
  const codeRanges: Array<{ start: number; end: number }> = [];
  const tags = [...content.matchAll(HTML_TAG)];
  let tagIndex = 0;
  const delimiters = [...content.matchAll(/`+|~{3,}/g)].filter((delimiter) => {
    while (tags[tagIndex] && tags[tagIndex]!.index + tags[tagIndex]![0].length <= delimiter.index)
      tagIndex += 1;
    const tag = tags[tagIndex];
    return !tag || delimiter.index < tag.index;
  });
  for (let index = 0; index < delimiters.length; index += 1) {
    const opening = delimiters[index]!;
    const lineStart = content.lastIndexOf("\n", opening.index - 1) + 1;
    const fenced =
      opening[0].length >= 3 && /^ {0,3}$/.test(content.slice(lineStart, opening.index));
    if (opening[0][0] === "~" && !fenced) continue;
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < delimiters.length; candidate += 1) {
      const closing = delimiters[candidate]!;
      if (!fenced && closing[0] === opening[0]) {
        closingIndex = candidate;
        break;
      }
      if (!fenced || closing[0][0] !== opening[0][0] || closing[0].length < opening[0].length)
        continue;
      const start = content.lastIndexOf("\n", closing.index - 1) + 1;
      const nextLine = content.indexOf("\n", closing.index);
      const end = nextLine === -1 ? content.length : nextLine;
      if (
        /^ {0,3}$/.test(content.slice(start, closing.index)) &&
        /^\s*$/.test(content.slice(closing.index + closing[0].length, end))
      ) {
        closingIndex = candidate;
        break;
      }
    }
    if (closingIndex === -1) {
      if (fenced) codeRanges.push({ start: opening.index, end: content.length });
      continue;
    }
    const closing = delimiters[closingIndex]!;
    codeRanges.push({ start: opening.index, end: closing.index + closing[0].length });
    index = closingIndex;
  }
  return tags.filter(
    (tag) => !codeRanges.some((range) => tag.index >= range.start && tag.index < range.end),
  );
}

/**
 * Called only for parsed HTML nodes, so Markdown code examples keep their literal tags.
 * `anchors` holds the replacements for the anchor tags still ahead, shared across sibling
 * inline HTML nodes because each of those carries a single tag.
 */
export function markdownHtmlContent(
  content: string,
  options: { readonly anchors?: string[]; readonly inTableCell?: boolean } = {},
): string {
  const tags = markdownHtmlTags(content);
  const anchors =
    options.anchors ??
    anchorMarkdown(tags.map((tag) => tag[0]).filter((tag) => ANCHOR_TAG.test(tag)));
  let result = "";
  let end = 0;
  for (const match of tags) {
    result += content.slice(end, match.index) + htmlTagMarkdown(match[0], anchors, options);
    end = match.index + match[0].length;
  }
  return result + content.slice(end);
}

function htmlTagMarkdown(
  tag: string,
  anchors: string[],
  options: { readonly inTableCell?: boolean },
): string {
  if (tag.startsWith("<!--")) return "";
  if (ANCHOR_TAG.test(tag)) return anchors.shift() ?? "";
  if (/^<img\b/i.test(tag)) {
    const src = attribute(tag, "src");
    if (!src) return "";
    const alt = (attribute(tag, "alt") ?? "").replace(/[\\[\]&]/g, "\\$&");
    return `![${alt}](${markdownDestination(src)})`;
  }
  if (/^<summary\b/i.test(tag)) return "\n\n**";
  if (/^<\/summary\s*>/i.test(tag)) return "**\n\n";
  // A line break would end the table row, so a cell keeps its content on one line.
  if (/^<br\b/i.test(tag)) return options.inTableCell ? " " : "  \n";
  if (/^<\/?(?:p|div|details)\b/i.test(tag)) return "\n\n";
  return "";
}

export function markdownWithHtml(markdown: string): string {
  if (!/<(?:!--|\/?[a-z])/i.test(markdown)) return markdown;
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode, inTableCell: boolean) => {
    if (!("children" in node)) return;
    inTableCell ||= node.type === "tableCell";
    const children: readonly MarkdownNode[] = node.children;
    // Inline HTML arrives one tag per node, so anchors pair across phrasing siblings.
    const anchors =
      node.type === "root" || node.type === "blockquote" || node.type === "listItem"
        ? undefined
        : anchorMarkdown(
            children.flatMap((child) =>
              child.type === "html"
                ? markdownHtmlTags(child.value)
                    .map((tag) => tag[0])
                    .filter((tag) => ANCHOR_TAG.test(tag))
                : [],
            ),
          );
    for (const child of children) {
      if (child.type !== "html") {
        visit(child, inTableCell);
        continue;
      }
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      const content = markdownHtmlContent(child.value, { anchors, inTableCell });
      if (start !== undefined && end !== undefined) edits.push({ start, end, content });
    }
  };
  visit(parser.parse(markdown), false);
  for (const edit of edits.reverse())
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  return markdown;
}

const INLINE_CODE_SPAN = /`+([^`\r\n]+)`+/g;

export function markdownWithInlineFileLinks(markdown: string, fileLink: RegExp): string {
  if (![...markdown.matchAll(INLINE_CODE_SPAN)].some(([, code]) => fileLink.test(code!.trim())))
    return markdown;
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const escaped = node.value.replace(/[\\[\]&]/g, "\\$&");
      if (
        start !== undefined &&
        end !== undefined &&
        fileLink.test(node.value) &&
        !/[<>]/.test(node.value)
      )
        edits.push({
          start,
          end,
          content: `[${escaped}](<${escaped}>)`,
        });
    } else if (node.type !== "link" && node.type !== "linkReference" && "children" in node)
      node.children.forEach(visit);
  };
  visit(parser.parse(markdown));
  for (const edit of edits.reverse())
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  return markdown;
}

// A delimiter row such as `|---|:--:|`, possibly inside a blockquote or list item.
function isTableDelimiterRow(line: string): boolean {
  if (!line.includes("-")) return false;
  const row = line.replace(/^[ \t>]+/, "").trim();
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .every((cell) => /^:?-+:?$/.test(cell.trim()));
}

// Cheap pre-check for a delimiter row two lines below text, so most messages skip the parse.
function mayHaveTableUnderText(markdown: string): boolean {
  if (!markdown.includes("|")) return false;
  const lines = markdown.split(/\r\n|\r|\n/);
  for (let index = 2; index < lines.length; index += 1) {
    if (isTableDelimiterRow(lines[index]!) && /[^\s>]/.test(lines[index - 2]!)) return true;
  }
  return false;
}

/**
 * GFM lets a table interrupt a paragraph, but the native parser (md4c) only starts a table
 * on a paragraph's first line, so a table right under a line of text renders as one
 * run-on paragraph. Insert the blank line md4c needs before each such table.
 */
export function markdownWithTableBreaks(markdown: string): string {
  if (!mayHaveTableUnderText(markdown)) return markdown;
  const lineStarts: number[] = [];
  const visit = (node: MarkdownNode) => {
    if (!("children" in node)) return;
    node.children.forEach((child, index) => {
      const previous = node.children[index - 1];
      const start = child.position?.start;
      if (
        child.type === "table" &&
        previous?.type === "paragraph" &&
        start?.offset !== undefined &&
        previous.position?.end.line === start.line - 1
      )
        lineStarts.push(
          Math.max(
            markdown.lastIndexOf("\n", start.offset - 1),
            markdown.lastIndexOf("\r", start.offset - 1),
          ) + 1,
        );
      visit(child);
    });
  };
  visit(parser.parse(markdown));
  for (const lineStart of lineStarts.reverse()) {
    // The header row may be a lazy line without its container markers (`>` or list indent),
    // so copy the delimiter row's markers onto the blank line and the header row.
    const [, header = "", cells = "", ending = "\n", markers = ""] =
      /^([ \t>]*)([^\r\n]*)(\r\n|\r|\n)([ \t>]*)/.exec(markdown.slice(lineStart)) ?? [];
    markdown =
      markdown.slice(0, lineStart) +
      `${markers.trimEnd()}${ending}${markers}${cells}` +
      markdown.slice(lineStart + header.length + cells.length);
  }
  return markdown;
}

export function parseMarkdownDocument(markdown: string): Root {
  return parser.parse(markdownWithHtml(markdown));
}

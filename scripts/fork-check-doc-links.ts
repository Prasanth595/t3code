#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - plain Node script.
// Fork: checks the relative links and anchors of the fork docs. Fork CI (Lint) and
// `vp run fork:check` run it. See docs/fork/operations.md "Check a change before you push".
//
//   node scripts/fork-check-doc-links.ts    (from the repository root)
//
// Limit: an anchor is checked only when it points into a markdown file, against the
// GitHub slugs of its headings. HTML anchors (`<a id>`) do not count. Revisit when a
// fork doc links to an HTML anchor.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import GithubSlugger from "github-slugger";
import remarkParse from "remark-parse";
import { unified } from "unified";

const DOC_GLOBS = ["README.md", "docs/fork*.md", "docs/fork/**/*.md", "apps/machine-map/*.md"];

interface MarkdownNode {
  readonly type: string;
  readonly url?: string | undefined;
  readonly value?: string | undefined;
  readonly children?: ReadonlyArray<MarkdownNode> | undefined;
  readonly position?: { readonly start: { readonly line: number } } | undefined;
}

// The working folder, so the script also checks a checkout that does not hold it yet.
const repoRoot = process.cwd();
const parser = unified().use(remarkParse);
const parsed = new Map<string, MarkdownNode>();

function parse(file: string): MarkdownNode {
  const cached = parsed.get(file);
  if (cached !== undefined) return cached;
  const tree: MarkdownNode = parser.parse(NodeFS.readFileSync(file, "utf8"));
  parsed.set(file, tree);
  return tree;
}

function* walk(node: MarkdownNode): Generator<MarkdownNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

function textOf(node: MarkdownNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

const anchorsByFile = new Map<string, ReadonlySet<string>>();

function anchorsOf(file: string): ReadonlySet<string> {
  const cached = anchorsByFile.get(file);
  if (cached !== undefined) return cached;
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  for (const node of walk(parse(file))) {
    if (node.type === "heading") anchors.add(slugger.slug(textOf(node)));
  }
  anchorsByFile.set(file, anchors);
  return anchors;
}

/** Returns the problem of one link, or undefined when the link resolves. */
function checkLink(file: string, url: string): string | undefined {
  // A scheme such as https: or mailto: is an external link.
  if (url.includes("://") || url.startsWith("mailto:")) return undefined;
  const hashIndex = url.indexOf("#");
  const pathPart = decodeURIComponent(hashIndex === -1 ? url : url.slice(0, hashIndex));
  const anchor = hashIndex === -1 ? undefined : decodeURIComponent(url.slice(hashIndex + 1));
  const target =
    pathPart === ""
      ? file
      : pathPart.startsWith("/")
        ? NodePath.join(repoRoot, pathPart)
        : NodePath.resolve(NodePath.dirname(file), pathPart);
  if (!NodeFS.existsSync(target)) return "the file does not exist";
  if (anchor === undefined || anchor === "" || !target.endsWith(".md")) return undefined;
  return anchorsOf(target).has(anchor) ? undefined : `no heading has the anchor #${anchor}`;
}

const files = NodeFS.globSync(DOC_GLOBS, { cwd: repoRoot }).map((file) =>
  NodePath.join(repoRoot, file),
);
const problems: Array<string> = [];
for (const file of files) {
  for (const node of walk(parse(file))) {
    if ((node.type !== "link" && node.type !== "definition") || node.url === undefined) continue;
    const problem = checkLink(file, node.url);
    if (problem === undefined) continue;
    const line = node.position?.start.line ?? 0;
    problems.push(`${NodePath.relative(repoRoot, file)}:${line}: ${node.url}: ${problem}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`${problems.length} broken links in ${files.length} docs.`);
  process.exitCode = 1;
} else {
  console.log(`All relative links resolve in ${files.length} docs.`);
}

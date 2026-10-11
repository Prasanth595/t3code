import type { Root, RootContent } from "mdast";
import type { Plugin } from "unified";
import { LRUCache } from "./lib/lruCache";

const MAX_PARSED_MARKDOWN_MEMORY = 16 * 1024 * 1024;
const parsedMarkdownCache = new LRUCache<Root>(256, MAX_PARSED_MARKDOWN_MEMORY);

function estimateTreeMemory(node: Root | RootContent): number {
  // Includes each node's source-position objects and its child-array slot.
  return (
    512 +
    ("children" in node
      ? node.children.reduce((size, child) => size + estimateTreeMemory(child), 0)
      : 0)
  );
}

/** Only for the standard chat syntax: extra plugins may change parsing.
 * Exact source keys share context-free trees across thread switches and modes.
 * Every render owns a copy because remark transforms mutate their input.
 */
export const remarkCacheParsedMarkdown: Plugin<[], Root> = function () {
  const original = this.parser;
  if (!original) return;
  let documentParsed = false;
  this.parser = (source, file) => {
    // List-indentation recovery parses synthetic text on the same processor.
    if (documentParsed) return original(source, file);
    documentParsed = true;
    const cached = parsedMarkdownCache.get(source);
    if (cached) return structuredClone(cached);

    const tree = original(source, file) as Root;
    // Account for the source key and string values as well as AST objects.
    const memory = source.length * 8 + estimateTreeMemory(tree);
    if (memory <= MAX_PARSED_MARKDOWN_MEMORY) {
      parsedMarkdownCache.set(source, structuredClone(tree), memory);
    }
    return tree;
  };
};

import { textDirection } from "~/textDirection";

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function proseText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "code") return " ";
  return (node.children ?? []).map(proseText).join("");
}

function isolateInlineCode(node: HastNode): void {
  if (node.tagName === "pre") return;
  if (node.tagName === "code") {
    node.properties = { ...node.properties, dir: "ltr" };
    return;
  }
  node.children?.forEach(isolateInlineCode);
}

/**
 * Gives each top-level block the direction of its own words, so an Arabic or
 * Hebrew reply reads right to left beside English ones. Lines inside a list or
 * quote follow it, keeping markers and rules on one side. Inline code is left
 * out of the count and isolated left to right, so its punctuation stays put.
 */
export function rehypeTextDirection() {
  return (tree: HastNode) => {
    for (const block of tree.children ?? []) {
      if (block.type !== "element" || block.tagName === "pre") continue;
      const dir = textDirection(proseText(block));
      if (dir) block.properties = { ...block.properties, dir };
    }
    isolateInlineCode(tree);
  };
}

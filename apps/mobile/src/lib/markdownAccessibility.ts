import { parseMarkdownDocument, type MarkdownNode } from "./markdownDocument";

function textContent(node: MarkdownNode): string {
  if (node.type === "definition") return "";
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (node.type === "break") return " ";
  if ("children" in node) {
    return node.children.map(textContent).join(node.type === "root" ? " " : "");
  }
  return "";
}

export function markdownAccessibilityLabel(markdown: string): string {
  return (
    textContent(parseMarkdownDocument(markdown)).replace(/\s+/g, " ").trim() || markdown.trim()
  );
}

import { parseMarkdownDocument, type MarkdownNode } from "./markdownDocument";
import { ENRICHED_INLINE_FILE_LINK_REGEX } from "./enrichedLinkPresentation";

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

export function markdownAccessibility(markdown: string) {
  const document = parseMarkdownDocument(markdown);
  const definitions = new Map<string, string>();
  const collectDefinitions = (node: MarkdownNode) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    if ("children" in node) node.children.forEach(collectDefinitions);
  };
  collectDefinitions(document);
  const targets: Array<{ kind: "link" | "image"; label: string; href: string }> = [];
  const visit = (node: MarkdownNode) => {
    const href =
      node.type === "link" || node.type === "image"
        ? node.url
        : node.type === "linkReference" || node.type === "imageReference"
          ? definitions.get(node.identifier)
          : node.type === "inlineCode" && ENRICHED_INLINE_FILE_LINK_REGEX.test(node.value)
            ? node.value
            : undefined;
    if (href) {
      targets.push({
        kind: node.type === "image" || node.type === "imageReference" ? "image" : "link",
        label: textContent(node).trim() || href,
        href,
      });
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(document);
  return { label: textContent(document).replace(/\s+/g, " ").trim(), targets };
}

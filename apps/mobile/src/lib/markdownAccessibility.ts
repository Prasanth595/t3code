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

export function markdownAccessibility(markdown: string) {
  const document = parseMarkdownDocument(markdown);
  const definitions = new Map(
    document.children.flatMap((node) =>
      node.type === "definition" ? [[node.identifier, node.url] as const] : [],
    ),
  );
  const links: Array<{ label: string; href: string }> = [];
  const visit = (node: MarkdownNode) => {
    const href =
      node.type === "link"
        ? node.url
        : node.type === "linkReference"
          ? definitions.get(node.identifier)
          : undefined;
    if (href) links.push({ label: textContent(node).trim() || href, href });
    if ("children" in node) node.children.forEach(visit);
  };
  visit(document);
  return { label: textContent(document).replace(/\s+/g, " ").trim(), links };
}

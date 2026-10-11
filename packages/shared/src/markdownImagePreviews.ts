import { unified } from "unified";
import remarkParse from "remark-parse";
import { parseFileUrlHref } from "./fileLinks.ts";
import { normalizeMarkdownLinkDestination, safeDecodeURIComponent } from "./markdownLinks.ts";
import { isWindowsAbsolutePath, stripSlashPrefixedWindowsDrive } from "./path.ts";

const parser = unified().use(remarkParse);
type ImageNode = {
  type: string;
  url?: string;
  identifier?: string;
  children?: ImageNode[];
};

function fileIdentity(path: string): string {
  const normalized = stripSlashPrefixedWindowsDrive(path);
  return isWindowsAbsolutePath(normalized)
    ? normalized.replace(/\\/g, "/").toLowerCase()
    : normalized;
}

function imageIdentity(destination: string): string {
  const normalized = normalizeMarkdownLinkDestination(destination);
  const file = /^file:/i.test(normalized) ? parseFileUrlHref(normalized) : null;
  return fileIdentity(safeDecodeURIComponent(file?.path ?? normalized));
}

/** Collect actual Markdown images, including references, while ignoring code examples. */
function embeddedImagePaths(markdown: string): Set<string> {
  const tree = parser.parse(markdown);
  const definitions = new Map<string, string>();
  const images: ImageNode[] = [];
  const visit = (node: ImageNode) => {
    if (
      node.type === "definition" &&
      node.identifier &&
      node.url &&
      !definitions.has(node.identifier)
    ) {
      definitions.set(node.identifier, node.url);
    } else if (node.type === "image" || node.type === "imageReference") {
      images.push(node);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return new Set(
    images.flatMap((image) => {
      const destination =
        image.url ?? (image.identifier ? definitions.get(image.identifier) : undefined);
      return destination === undefined ? [] : [imageIdentity(destination)];
    }),
  );
}

/** Add missing generated-file previews once, without another provider/tool invocation. */
export function appendMissingImagePreviews(
  finalText: string,
  savedPaths: Iterable<string>,
  otherFinalTexts: Iterable<string> = [],
): string {
  const embedded = embeddedImagePaths(finalText);
  for (const text of otherFinalTexts) {
    if (text === finalText) continue;
    for (const path of embeddedImagePaths(text)) embedded.add(path);
  }
  let result = finalText;
  for (const path of savedPaths) {
    if (path.trim().length === 0) continue;
    const identity = fileIdentity(path);
    if (embedded.has(identity)) continue;
    embedded.add(identity);
    const destination = isWindowsAbsolutePath(path) ? path.replace(/\\/g, "/") : path;
    const encoded = encodeURI(destination).replace(/[?#]/g, encodeURIComponent);
    result += `${result.length > 0 ? "\n\n" : ""}![Generated image](<${encoded}>)`;
  }
  return result;
}

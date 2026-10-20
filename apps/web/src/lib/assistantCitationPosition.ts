import type { AssistantCitationSourceAnchor } from "./assistantTextSelection";

export function assistantCitationBounds({ viewport, boundary }: AssistantCitationSourceAnchor) {
  const rect = (boundary ?? viewport).getBoundingClientRect();
  const view = viewport.ownerDocument.defaultView!;
  const left = Math.min(view.innerWidth, Math.max(0, rect.left));
  const top = Math.min(view.innerHeight, Math.max(0, rect.top));
  return new DOMRect(
    left,
    top,
    Math.max(0, Math.min(view.innerWidth, rect.right) - left),
    Math.max(0, Math.min(view.innerHeight, rect.bottom) - top),
  );
}

export function assistantCitationAnchorRect(anchor: AssistantCitationSourceAnchor) {
  const bounds = assistantCitationBounds(anchor);
  const rect =
    Array.from(anchor.range.getClientRects()).find(
      (line) =>
        line.bottom > bounds.top &&
        line.top < bounds.bottom &&
        line.right > bounds.left &&
        line.left < bounds.right,
    ) ?? anchor.range.getBoundingClientRect();
  const source = anchor.source.getBoundingClientRect();
  const left = Math.max(bounds.left, Math.min(source.left, bounds.right));
  const right = Math.max(left, Math.min(source.right, bounds.right));
  return new DOMRect(
    Math.min(Math.max(rect.right, left), right),
    Math.min(Math.max(rect.top, bounds.top), bounds.bottom),
    0,
    0,
  );
}

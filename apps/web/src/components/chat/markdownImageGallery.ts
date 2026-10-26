import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { SOURCE_CONTROL_MEDIA_ASSET, type EnvironmentId } from "@t3tools/contracts";
import { markdownImageSourceFragment } from "@t3tools/client-runtime/markdown-images";
import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";
import { mediaUrlReference } from "@t3tools/client-runtime/media-reference";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";

export interface MarkdownMediaLocation {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

export const markdownImageItems = new WeakMap<Element, ExpandedImageItem>();

export function markdownImageGallery(
  element: Element,
  selected: ExpandedImageItem,
  location?: MarkdownMediaLocation,
): ExpandedImagePreview {
  const scope = element.closest("[data-image-gallery]") ?? element.closest(".chat-markdown");
  const images: ExpandedImageItem[] = [];
  let index = -1;
  for (const image of scope?.querySelectorAll("img") ?? []) {
    const registered = markdownImageItems.get(image);
    if (!registered) continue;
    const link = image.closest("a");
    const href = link?.getAttribute("href") ?? "";
    if (link && mediaKindFromPath(href) !== "image") continue;
    const linkedSource =
      resolveExternalWebLinkHost(href) !== null ? resolveProtocolRelativeMediaUrl(href) : null;
    const reference = mediaUrlReference(href);
    const asset = registered.actionsSource?.asset ?? selected.actionsSource?.asset;
    const linkedMedia = sourceControlClients.mediaUrl(href);
    const environmentId = location?.environmentId ?? asset?.environmentId;
    const cwd =
      location?.cwd ??
      (asset?.resource._tag === SOURCE_CONTROL_MEDIA_ASSET ? asset.resource.cwd : undefined);
    const linkedAsset =
      environmentId && cwd && linkedMedia?.definition.kind === "bitbucket"
        ? {
            environmentId,
            resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd, url: linkedMedia.fetchUrl },
          }
        : undefined;
    const item = linkedSource
      ? {
          ...registered,
          src: linkedSource,
          originalUrl: href,
          srcFragment: markdownImageSourceFragment(href),
          actionsSource: {
            kind: "image" as const,
            name: registered.name,
            src: linkedSource,
            ...(reference ? { reference } : {}),
            ...(linkedAsset ? { asset: linkedAsset } : {}),
          },
        }
      : registered;
    if (
      image === element ||
      (!markdownImageItems.has(element) && index < 0 && item.src === selected.src)
    ) {
      index = images.length;
      images.push(selected);
    } else {
      images.push(item);
    }
  }
  return index < 0 ? { images: [selected], index: 0 } : { images, index };
}

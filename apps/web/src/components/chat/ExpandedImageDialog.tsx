import { memo, useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { Image as ImageGlyph, Text as TextGlyph } from "lucide";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { OpenMediaLink } from "../media/OpenMediaLink";
import { MediaActions, type MediaActionSource } from "../media/MediaActions";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { isContextMenuOpen } from "../../contextMenuFallback";
import {
  SnapShotAccessibilityData,
  SnapShotContentsButton,
  snapShotAccessibilityDetails,
} from "./SnapShotAttachmentDetails";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Kbd } from "../ui/kbd";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";
import { composerFloatingLayerProps } from "./composerEventScope";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { expandedImageKey } from "./ExpandedImagePreview";
import { registerThreadOverlay } from "./threadOverlayRetention";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(var(--media-width),32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

const MEDIA_HEIGHT_CLASS =
  "[--media-height:min(calc((100vh-var(--native-titlebar-height,0px))*0.86),calc(100vh-var(--native-titlebar-height,0px)-160px))]";
const FILMSTRIP_MEDIA_HEIGHT_CLASS =
  "[--media-height:min(calc((100vh-var(--native-titlebar-height,0px))*0.86),calc(100vh-var(--native-titlebar-height,0px)-244px))]";
const FILMSTRIP_RESERVED_HEIGHT = 244;

function ExpandedMediaFailure({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
      {children}
    </div>
  );
}

function ExpandedVideo({ item }: { readonly item: ExpandedImageItem }) {
  const asset = item.actionsSource?.asset;
  const assetUrl = useAssetUrlState(asset?.environmentId ?? null, asset?.resource ?? null);
  const refreshAssetUrl = useAssetUrlRefresh(asset?.environmentId ?? null, asset?.resource ?? null);
  const src = asset
    ? assetUrl._tag === "Success"
      ? assetUrl.url + (item.srcFragment ?? "")
      : null
    : item.src;
  return (
    <MediaVideoPlayer
      src={src}
      label={item.name}
      sourceFailed={assetUrl._tag === "Failure"}
      originalUrl={item.originalUrl}
      preload="metadata"
      autoPlay={item.autoPlay ?? true}
      className="block max-h-[var(--media-height)] max-w-[var(--media-width)] text-center"
      videoClassName="aspect-auto max-h-[var(--media-height)] w-auto max-w-[var(--media-width)] rounded-lg border border-border/70 shadow-2xl"
      stateClassName={EXPANDED_MEDIA_STATE_CLASS_NAME}
      onRetry={asset ? refreshAssetUrl : undefined}
    />
  );
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const [accessibilityDetailsSrc, setAccessibilityDetailsSrc] = useState<string | null>(null);
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  const thumbnailRefs = useRef(new Map<number, HTMLButtonElement | null>());
  const [returnFocusTarget] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  // The host unmounts the dialog outright, so Base UI never runs finalFocus. Without
  // this, focus stays on the removed dialog, and the composer that owned the opener
  // reads that as a blur and rests.
  const close = () => {
    flushSync(onClose);
    if (returnFocusTarget?.isConnected) returnFocusTarget.focus({ preventScroll: true });
  };
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const imageCount = preview.images.length;
  const showFilmstrip = imageCount > 1;
  const index =
    imageCount > 0 ? (((preview.index + imageOffset) % imageCount) + imageCount) % imageCount : 0;
  const item = preview.images[index];
  const source: MediaActionSource = item?.actionsSource ?? {
    kind: item?.type === "video" ? "video" : "image",
    name: item?.name ?? "Media",
    src: item?.src ?? null,
  };
  const openFile = source.onOpenFile;
  const actionsSource: MediaActionSource = openFile
    ? {
        ...source,
        onOpenFile: () => {
          openFile();
          close();
        },
      }
    : source;

  const navigateImage = (direction: -1 | 1) => {
    setNavigated(true);
    setImageOffset((current) => current + direction);
  };

  const showImage = (targetIndex: number) => {
    if (targetIndex === index) return;
    setNavigated(true);
    setImageOffset((current) => current + targetIndex - index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isContextMenuOpen() || event.target instanceof HTMLVideoElement)
      return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (zoomableImageRef.current?.pan(key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (preview.images.length <= 1) return;
    if (key === "ArrowLeft" || key === "h") {
      event.preventDefault();
      event.stopPropagation();
      navigateImage(-1);
      return;
    }
    if (key !== "ArrowRight" && key !== "l") return;
    event.preventDefault();
    event.stopPropagation();
    navigateImage(1);
  };

  useEffect(() => {
    thumbnailRefs.current
      .get(index)
      ?.scrollIntoView({ behavior: "auto", block: "nearest", inline: "center" });
  }, [index]);

  if (!item) return null;
  const mediaLabel = item.type === "video" ? "video" : "image";
  const openOriginalLink =
    item.originalUrl && resolveExternalWebLinkHost(item.originalUrl) !== null ? (
      <OpenMediaLink originalUrl={item.originalUrl} />
    ) : null;
  const accessibilityDetails = item.source ? snapShotAccessibilityDetails(item.source) : undefined;
  const showingAccessibilityDetails =
    Boolean(accessibilityDetails) && accessibilityDetailsSrc === item.src;
  const contentsLabel = showingAccessibilityDetails
    ? "Show screenshot"
    : accessibilityDetails?.format === "json"
      ? "Show accessibility JSON"
      : "Show extracted text";

  return (
    <Dialog
      open
      onOpenChange={(open, eventDetails) => {
        if (open) return;
        // Escape belongs to an open context menu first.
        if (eventDetails.reason === "escape-key" && isContextMenuOpen()) {
          eventDetails.cancel();
          return;
        }
        close();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className={`row-start-1 h-full max-h-[92vh] w-[92vw] max-w-[92vw] items-center justify-center overflow-visible [--media-width:92vw] ${showFilmstrip ? FILMSTRIP_MEDIA_HEIGHT_CLASS : MEDIA_HEIGHT_CLASS} sm:[--media-width:calc(92vw-96px)]`}
        style={{ maxHeight: "calc(100vh - var(--native-titlebar-height, 0px) - 3rem)" }}
        onKeyDown={onKeyDown}
        initialFocus={closeButtonRef}
        finalFocus={() => returnFocusTarget}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <DialogTitle className="sr-only">Expanded {mediaLabel} preview</DialogTitle>
        <Button
          type="button"
          ref={closeButtonRef}
          size="icon-sm"
          variant="media-close"
          className="absolute right-0 top-0 z-20"
          onClick={close}
          aria-label={`Close ${mediaLabel} preview`}
        >
          <XIcon />
        </Button>
        {preview.images.length > 1 && (
          <>
            <span
              aria-hidden="true"
              className="absolute left-0 top-0 z-20 rounded-full bg-black/65 px-2.5 py-1 text-2xs font-medium tabular-nums text-white/90 ring-1 ring-white/20"
            >
              {`${index + 1} / ${imageCount}`}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon"
                    variant="media-navigation"
                    className="left-0 top-auto bottom-0 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
                    aria-label="Previous media"
                    onClick={() => navigateImage(-1)}
                  />
                }
              >
                <ChevronLeftIcon className="size-5" />
              </TooltipTrigger>
              <TooltipPopup side="right">
                Previous (<Kbd>←</Kbd> or <Kbd>H</Kbd>)
              </TooltipPopup>
            </Tooltip>
          </>
        )}
        <div className="flex h-full min-h-0 w-full flex-col items-center">
          <div className="flex min-h-0 w-full flex-1 items-center justify-center">
            <MediaActions source={actionsSource}>
              <div className="relative isolate z-10 flex max-h-full max-w-[var(--media-width)] flex-col items-center">
                <div
                  key={index}
                  className={
                    navigated
                      ? "duration-150 ease-out starting:opacity-0 transition-opacity motion-reduce:transition-none"
                      : undefined
                  }
                >
                  {item.type === "video" ? (
                    <ExpandedVideo key={index} item={item} />
                  ) : showingAccessibilityDetails ? (
                    accessibilityDetails ? (
                      <SnapShotAccessibilityData
                        details={accessibilityDetails}
                        className="h-[min(var(--media-height),40rem)] w-[min(var(--media-width),42rem)] transition-opacity duration-140 ease-out starting:opacity-0 rounded-lg border border-border/70 bg-background p-4 text-xs leading-5 shadow-2xl motion-reduce:transition-none"
                      />
                    ) : null
                  ) : item.src === null || failedImageSrc === item.src ? (
                    <ExpandedMediaFailure>
                      <p>
                        {openOriginalLink
                          ? "This image could not be loaded."
                          : "Image unavailable. The file may have been moved or deleted."}
                      </p>
                      {openOriginalLink}
                    </ExpandedMediaFailure>
                  ) : (
                    <ZoomableImage
                      ref={zoomableImageRef}
                      key={`${index}:${item.src}`}
                      src={item.src}
                      name={item.name}
                      mimeType={item.mimeType}
                      reservedHeight={showFilmstrip ? FILMSTRIP_RESERVED_HEIGHT : undefined}
                      onError={() => setFailedImageSrc(item.src)}
                    />
                  )}
                </div>
                <div className="mt-2 flex max-w-[var(--media-width)] items-center justify-center gap-1.5 text-xs text-white/80 max-sm:px-10">
                  <span className="truncate" aria-live="polite" aria-atomic="true">
                    {item.name}
                    {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
                  </span>
                  {accessibilityDetails && item.source ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={contentsLabel}
                            aria-pressed={showingAccessibilityDetails}
                            onClick={() =>
                              setAccessibilityDetailsSrc(
                                showingAccessibilityDetails ? null : item.src,
                              )
                            }
                            size="icon-micro"
                            variant="overlay"
                          />
                        }
                      >
                        <MorphIcon
                          className="size-3"
                          aria-hidden="true"
                          icon={showingAccessibilityDetails ? ImageGlyph : TextGlyph}
                        />
                      </TooltipTrigger>
                      <TooltipPopup side="top">{contentsLabel}</TooltipPopup>
                    </Tooltip>
                  ) : item.source ? (
                    <SnapShotContentsButton source={item.source} side="top" />
                  ) : null}
                </div>
              </div>
            </MediaActions>
          </div>
          {showFilmstrip && (
            <div className="mt-3 flex w-full shrink-0 justify-center bg-black/70 px-3 py-2.5 max-sm:pb-12">
              <div className="flex max-w-[min(var(--media-width),40rem)] items-center justify-center rounded-full bg-black/80 px-2 py-2 ring-1 ring-white/15 max-sm:max-w-[calc(100%-5rem)]">
                <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto overscroll-contain [scrollbar-width:thin]">
                  {preview.images.map((thumbnail, thumbnailIndex) => (
                    <button
                      // oxlint-disable-next-line react/no-array-index-key -- The block is fixed for the dialog's lifetime.
                      key={thumbnailIndex}
                      type="button"
                      aria-label={`Show image ${thumbnailIndex + 1} of ${imageCount}: ${thumbnail.name}`}
                      aria-current={thumbnailIndex === index ? "true" : undefined}
                      ref={(node) => {
                        thumbnailRefs.current.set(thumbnailIndex, node);
                      }}
                      onClick={() => showImage(thumbnailIndex)}
                      className={`h-9 w-12 shrink-0 cursor-pointer overflow-hidden rounded-md border bg-black/70 p-0 outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-inset active:opacity-100 ${
                        thumbnailIndex === index
                          ? "border-white/40 opacity-100"
                          : "border-white/10 opacity-45 hover:opacity-85"
                      }`}
                    >
                      {thumbnail.src === null ? null : (
                        <img
                          src={thumbnail.src}
                          alt=""
                          draggable={false}
                          className="size-full object-cover"
                        />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        {preview.images.length > 1 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon"
                  variant="media-navigation"
                  className="right-0 top-auto bottom-0 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
                  aria-label="Next media"
                  onClick={() => navigateImage(1)}
                />
              }
            >
              <ChevronRightIcon className="size-5" />
            </TooltipTrigger>
            <TooltipPopup side="left">
              Next (<Kbd>→</Kbd> or <Kbd>L</Kbd>)
            </TooltipPopup>
          </Tooltip>
        )}
      </DialogPopup>
    </Dialog>
  );
});

// Keep preview state outside ChatView to isolate dialog renders.
type ExpandedImagePreviewState = {
  readonly threadKey: string;
  readonly preview: ExpandedImagePreview;
} | null;

const expandedImagePreviewAtom = Atom.make<ExpandedImagePreviewState>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("chat:expanded-image-preview"),
);

function ownedSrc(state: ExpandedImagePreviewState): string | null {
  const item = state?.preview.images[state.preview.index];
  return item?.ownsSrc === true ? item.src : null;
}

// The preview owns a blob URL made for it, so whatever replaces it releases that URL.
function setExpandedImagePreview(next: ExpandedImagePreviewState): void {
  const previous = ownedSrc(appAtomRegistry.get(expandedImagePreviewAtom));
  appAtomRegistry.set(expandedImagePreviewAtom, next);
  if (previous !== null && previous !== ownedSrc(next)) URL.revokeObjectURL(previous);
}

export function openExpandedImagePreview(threadKey: string, preview: ExpandedImagePreview): void {
  setExpandedImagePreview({ threadKey, preview });
}

function closeExpandedImagePreview(): void {
  setExpandedImagePreview(null);
}

// Leaving the thread's route (or the chat view) drops its preview.
registerThreadOverlay((threadKey) => {
  const current = appAtomRegistry.get(expandedImagePreviewAtom);
  if (current !== null && current.threadKey !== threadKey) closeExpandedImagePreview();
});

export function ExpandedImageDialogHost({ threadKey }: { readonly threadKey: string }) {
  const state = useAtomValue(expandedImagePreviewAtom);
  const preview = state?.threadKey === threadKey ? state.preview : null;
  if (preview === null) return null;
  return (
    <ExpandedImageDialog
      key={expandedImageKey(preview)}
      preview={preview}
      onClose={closeExpandedImagePreview}
    />
  );
}

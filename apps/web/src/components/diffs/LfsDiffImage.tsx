import type { ScopedThreadRef } from "@t3tools/contracts";
import { MISSING_FILE_ACCESS_MESSAGE } from "@t3tools/client-runtime/state/assets";
import { LFS_IMAGE_MAX_BYTES } from "@t3tools/shared/gitLfs";
import { useEffect, useState } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useDelayedStatus } from "~/hooks/useDelayedStatus";
import type { DiffImageCache, DiffImageState } from "~/lib/diffImageCache";
import type { LfsImageSide } from "~/lib/diffRendering";
import { formatBytes } from "~/lib/formatBytes";

type LfsDiffImageProps = { image: LfsImageSide; threadRef: ScopedThreadRef; cache: DiffImageCache };

function LfsImageContent({ image, threadRef, cache }: LfsDiffImageProps) {
  const resource = {
    _tag: "lfs-image" as const,
    threadId: threadRef.threadId,
    oid: image.oid,
    path: image.path,
  };
  const asset = useAssetUrlState(threadRef.environmentId, resource);
  const refresh = useAssetUrlRefresh(threadRef.environmentId, resource);
  const cacheKey = `${threadRef.environmentId}:${image.oid}`;
  const [state, setState] = useState<DiffImageState>({ status: "queued" });
  const [decodedUrl, setDecodedUrl] = useState<string | null>(null);
  const url = asset._tag === "Success" ? asset.url : undefined;
  const width = asset._tag === "Success" ? asset.imageDimensions?.width : undefined;
  const height = asset._tag === "Success" ? asset.imageDimensions?.height : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Hold a shared download and blob URL only while this preview is mounted.
  useEffect(() => {
    if (!url) return;
    return cache.acquire(
      {
        key: cacheKey,
        url,
        sizeBytes: image.size,
        ...(width !== undefined && height !== undefined ? { dimensions: { width, height } } : {}),
      },
      setState,
    );
  }, [cache, cacheKey, url, image.size, width, height]);

  const pending =
    asset._tag === "Loading" ||
    state.status === "queued" ||
    state.status === "loading" ||
    (state.status === "ready" && decodedUrl !== state.url);
  const showStatus = useDelayedStatus(
    cacheKey,
    pending || state.status === "capacity" ? true : null,
  );
  if (asset._tag === "Failure" && asset.reason === "missing-file-access") {
    return <p className="text-xs text-muted-foreground">{MISSING_FILE_ACCESS_MESSAGE}</p>;
  }
  if (asset._tag === "Failure" || (asset._tag === "Success" && state.status === "error")) {
    return (
      <div className="flex flex-col items-center gap-2">
        <p className="text-xs text-muted-foreground">
          Image unavailable locally, unsupported, or over preview limits.
        </p>
        <Button
          size="compact"
          variant="ghost"
          onClick={() => {
            void refresh()
              .then((freshUrl) => {
                if (freshUrl) cache.retry(cacheKey, freshUrl);
              })
              .catch(() => {});
          }}
        >
          Retry image
        </Button>
      </div>
    );
  }
  return (
    <div className="relative flex size-full min-h-0 items-center justify-center">
      {asset._tag === "Success" && state.status === "ready" ? (
        <img
          ref={(element) => {
            // A virtualized slot can attach an image that has already finished loading.
            if (element?.complete && element.naturalWidth > 0) setDecodedUrl(element.src);
          }}
          src={state.url}
          alt={`${image.label}: ${image.path}`}
          decoding="async"
          className="max-h-full max-w-full object-contain"
          onLoad={(event) => setDecodedUrl(event.currentTarget.src)}
          onError={() => cache.reject(cacheKey)}
        />
      ) : null}
      {showStatus && state.status === "capacity" ? (
        <p className="text-center text-xs text-muted-foreground">
          Preview paused to limit memory use. Collapse other image files to resume.
        </p>
      ) : showStatus && pending ? (
        <div
          className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground"
          role="status"
        >
          <Spinner size="lg" />
          Loading image…
        </div>
      ) : null}
    </div>
  );
}

export function LfsDiffImage({ image, ...props }: LfsDiffImageProps) {
  return (
    <figure className="m-0 flex h-64 flex-col gap-2 border-y border-border/30 bg-background p-3 font-sans">
      <figcaption className="text-xs text-muted-foreground">
        {image.label} · Git LFS · {formatBytes(image.size)}
      </figcaption>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {image.size > LFS_IMAGE_MAX_BYTES ? (
          <p className="text-xs text-muted-foreground">
            Image exceeds the {formatBytes(LFS_IMAGE_MAX_BYTES)} preview limit.
          </p>
        ) : (
          <LfsImageContent key={image.oid} image={image} {...props} />
        )}
      </div>
    </figure>
  );
}

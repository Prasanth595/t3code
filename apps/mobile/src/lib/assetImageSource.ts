import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import type { ImageSource } from "expo-image";

/**
 * Disk cache key for an asset image. Every mint signs a new URL, and a
 * reconnect mints again, so a URL-keyed cache misses each time. Attachments
 * never change once stored, so they cache under their id instead.
 */
export function assetImageCacheKey(
  environmentId: EnvironmentId,
  resource: AssetResource,
): string | undefined {
  return resource._tag === "attachment"
    ? `t3-attachment:${environmentId}:${resource.attachmentId}`
    : undefined;
}

/** expo-image source for a signed asset URL. */
export function assetImageSource(
  environmentId: EnvironmentId,
  resource: AssetResource,
  uri: string,
): ImageSource {
  const cacheKey = assetImageCacheKey(environmentId, resource);
  return cacheKey === undefined ? { uri } : { uri, cacheKey };
}

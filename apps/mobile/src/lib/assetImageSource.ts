import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import type { ImageSource } from "expo-image";

import { withRequestHeaders } from "../connection/requestHeaders";

/**
 * Every mint signs a new URL, and a reconnect mints again, so a URL-keyed cache
 * misses each time. Attachments never change once stored, so they cache under
 * their id instead.
 */
export function assetImageSource(
  environmentId: EnvironmentId,
  resource: AssetResource,
  uri: string,
): ImageSource {
  return withRequestHeaders(
    resource._tag === "attachment"
      ? {
          uri,
          cacheKey: `t3-attachment:${JSON.stringify([environmentId, resource.attachmentId])}`,
        }
      : { uri },
  );
}

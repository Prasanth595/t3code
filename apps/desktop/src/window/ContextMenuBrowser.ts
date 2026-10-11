/** Native fallback for images and sandboxed document frames that cannot bubble DOM events. */
export function contextMenuBrowserUrl(params: {
  readonly mediaType?: string;
  readonly srcURL?: string;
  readonly linkURL?: string;
  readonly frameURL?: string;
}): string | undefined {
  const candidate =
    params.mediaType === "image" ? params.srcURL : params.linkURL || params.frameURL;
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    // App assets must go through the renderer's resource-aware mint operation.
    // Reusing a signed URL here bypasses expiry renewal and grant revocation.
    if (url.pathname.startsWith("/api/assets/")) return undefined;
    if (
      !params.linkURL &&
      params.mediaType !== "image" &&
      !/^\/api\/assets\/.+\.(?:html?|pdf)$/i.test(url.pathname)
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Ask an embedded document's owner to reauthorize its resource on selection. */
export function assetFrameBrowserRequest(params: {
  readonly frameURL?: string;
  readonly x: number;
  readonly y: number;
}): string | undefined {
  try {
    const url = new URL(params.frameURL ?? "");
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !/^\/api\/assets\/.+\.html?$/i.test(url.pathname) ||
      !Number.isFinite(params.x) ||
      !Number.isFinite(params.y)
    )
      return undefined;
    return `window.parent.postMessage(${JSON.stringify({
      jsonrpc: "2.0",
      method: "t3/open-asset-externally",
      params: { x: params.x, y: params.y },
    })}, "*")`;
  } catch {
    return undefined;
  }
}

import type { AssetCreateUrlResult, AssetResource, EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";

import { readLocalApi } from "../localApi";

export function isExternalBrowserFile(path: string): boolean {
  const extension = /\.[^./\\]+$/.exec(path)?.[0];
  return extension !== undefined && hostPreviewMimeTypeFromExtension(extension) !== null;
}

function externalBrowserUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("This file cannot be opened in an external browser.");
  }
  return parsed.href;
}

/** Reserve a web tab in the click, before resolving a file or minting its URL. */
export async function openExternalBrowserResource(
  resolveUrl: () => Promise<string>,
): Promise<void> {
  const tab =
    typeof window !== "undefined" && !window.desktopBridge
      ? window.open("about:blank", "_blank")
      : undefined;
  if (tab === null) throw new Error("Allow popups for T3 Code to open this file.");
  if (tab) tab.opener = null;
  try {
    const url = externalBrowserUrl(await resolveUrl());
    if (tab) {
      if (tab.closed) throw new Error("The browser tab was closed before the file was ready.");
      tab.location.replace(url);
    } else {
      const api = readLocalApi();
      if (!api) throw new Error("The browser opener is unavailable.");
      await api.shell.openExternal(url);
    }
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** Keep the OS opener restricted to web URLs; a remote path is never a local file URL. */
export async function openExternalBrowserUrl(url: string): Promise<void> {
  const safeUrl = externalBrowserUrl(url);
  await openExternalBrowserResource(() => Promise.resolve(safeUrl));
}

/** Mint on the user's action, so old threads and expired image previews still open. */
export async function openAssetExternally<E>(input: {
  readonly environmentId: EnvironmentId;
  readonly resource: AssetResource;
  readonly httpBaseUrl: string;
  readonly assertCanOpen?: () => void;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, E>>;
}): Promise<void> {
  input.assertCanOpen?.();
  await openExternalBrowserResource(async () => {
    const result = await input.createAssetUrl({
      environmentId: input.environmentId,
      input: { resource: input.resource },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    input.assertCanOpen?.();
    const url = resolveAssetUrl(input.httpBaseUrl, result.value.relativeUrl);
    if (!url) throw new Error("The environment returned an invalid file URL.");
    return url;
  });
}

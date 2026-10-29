import type * as Electron from "electron";

function isApplicationUrl(url: string, applicationUrl: string): boolean {
  try {
    const requested = new URL(url);
    const application = new URL(applicationUrl);
    // Custom schemes have an opaque origin in Node's URL, so compare scheme and host.
    return requested.protocol === application.protocol && requested.host === application.host;
  } catch {
    return false;
  }
}

/**
 * Electron grants every request in a session without a handler, and the main window keeps that
 * default except for capture devices: only T3 Code's own page may record, and only audio, for
 * voice input. Browser previews run in separate sessions with their own policy.
 */
export function allowsMainWindowPermission(input: {
  readonly permission: string;
  readonly requestingUrl: string;
  readonly mediaTypes: ReadonlyArray<string> | undefined;
  readonly applicationUrl: string;
}): boolean {
  if (input.permission !== "media") return true;
  const mediaTypes = input.mediaTypes ?? [];
  return (
    isApplicationUrl(input.requestingUrl, input.applicationUrl) &&
    mediaTypes.length > 0 &&
    mediaTypes.every((mediaType) => mediaType === "audio")
  );
}

export function installMainWindowPermissions(
  session: Pick<Electron.Session, "setPermissionRequestHandler">,
  applicationUrl: string,
): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(
      allowsMainWindowPermission({
        permission,
        requestingUrl: details.requestingUrl,
        mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
        applicationUrl,
      }),
    );
  });
}

let desktopBearerTokenPromise: Promise<string> | null = null;

export function readDesktopPrimaryBearerToken(rejectedToken?: string): Promise<string | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }
  const bridge = window.desktopBridge;
  if (!bridge) {
    return Promise.resolve(null);
  }

  // Only coalesce in-flight reads. The main process owns the expiry-aware cache.
  if (rejectedToken !== undefined) desktopBearerTokenPromise = null;
  desktopBearerTokenPromise ??= bridge.getLocalEnvironmentBearerToken(rejectedToken).finally(() => {
    desktopBearerTokenPromise = null;
  });
  return desktopBearerTokenPromise;
}

export function __resetDesktopPrimaryAuthForTests(): void {
  desktopBearerTokenPromise = null;
}

export interface CloseGuardOptions {
  /**
   * Shows the window and asks its renderer to confirm, tagging the request so
   * the reply can be matched to it. Returns false when no renderer can answer,
   * which lets the close proceed.
   */
  readonly requestConfirmation: (requestId: number) => boolean;
}

/**
 * Tracks whether closing the main window or quitting would stop running work.
 * The renderer reports its busy thread count; while it is nonzero, every close
 * and quit path waits for the renderer's confirmation. A confirmed exit stays
 * confirmed, so the window close and the quit it causes ask only once.
 */
export function makeCloseGuard(options: CloseGuardOptions) {
  let busyThreadCount = 0;
  let confirmed = false;
  let nextRequestId = 0;
  let pending: {
    readonly requestId: number;
    readonly promise: Promise<boolean>;
    readonly resolve: (ok: boolean) => void;
  } | null = null;

  const settle = (ok: boolean) => {
    const current = pending;
    pending = null;
    if (ok) confirmed = true;
    current?.resolve(ok);
  };

  return {
    setBusyThreadCount: (count: number) => {
      busyThreadCount = count;
    },
    /** True when closing or quitting may proceed without asking. */
    canExit: () => confirmed || busyThreadCount === 0,
    /** Resolves true once the user confirms, or when nothing needs confirming. */
    confirm: (): Promise<boolean> => {
      if (confirmed || busyThreadCount === 0) return Promise.resolve(true);
      // Repeated close clicks and shortcuts share the prompt already showing.
      if (pending !== null) return pending.promise;
      let resolve!: (ok: boolean) => void;
      const promise = new Promise<boolean>((resolvePromise) => {
        resolve = resolvePromise;
      });
      const requestId = ++nextRequestId;
      pending = { requestId, promise, resolve };
      if (!options.requestConfirmation(requestId)) settle(true);
      return promise;
    },
    /**
     * The renderer's answer to a confirmation. A reply to a request that was
     * already cancelled, such as one from a renderer that since reloaded, is
     * ignored so it cannot answer a newer prompt.
     */
    resolve: (requestId: number, ok: boolean) => {
      if (pending?.requestId === requestId) settle(ok);
    },
    /**
     * The renderer reloaded or exited: its count is stale and its prompt is
     * gone. Cancel the pending close; the next one asks the new renderer.
     */
    reset: () => {
      busyThreadCount = 0;
      if (pending !== null) settle(false);
    },
  };
}

export type CloseGuard = ReturnType<typeof makeCloseGuard>;

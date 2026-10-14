export interface CloseGuardOptions {
  /**
   * Shows the window and asks its renderer to confirm. Returns false when no
   * renderer can answer, which lets the close proceed.
   */
  readonly requestConfirmation: () => boolean;
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
  let pending: { readonly promise: Promise<boolean>; resolve: (ok: boolean) => void } | null = null;

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
      pending = { promise, resolve };
      if (!options.requestConfirmation()) settle(true);
      return promise;
    },
    /** The renderer's answer to the pending confirmation. */
    resolve: (ok: boolean) => {
      if (pending !== null) settle(ok);
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

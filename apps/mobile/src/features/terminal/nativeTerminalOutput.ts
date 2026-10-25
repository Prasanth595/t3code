import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";

/** Serialize bridge writes; a React render is not a native delivery receipt. */
export function createNativeTerminalOutputWriter(
  write: (data: string, reset: boolean) => Promise<boolean>,
) {
  let cursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
  let latest: TerminalOutputState | null = null;
  let pending: Promise<void> | null = null;
  let disposed = false;
  let revision = 0;

  const drain = async () => {
    try {
      while (!disposed && latest !== null) {
        const output = latest;
        const attemptedRevision = revision;
        const update = readTerminalOutputUpdate(output, cursor);
        if (update.type === "none") return;
        try {
          if (!(await write(update.data, update.type === "reset"))) {
            // A layout notification may arrive before the rejection receipt.
            // Retry only when there was another explicit update, never on a timer.
            if (revision !== attemptedRevision) continue;
            return;
          }
          cursor = update.cursor;
        } catch (error) {
          // Delivery may have happened before the bridge failed. The next update
          // must replay a bounded snapshot instead of duplicating an append.
          cursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
          throw error;
        }
        if (latest === output) return;
      }
    } finally {
      // Clear the writer in the same continuation that exits the drain.
      pending = null;
    }
  };

  return {
    update(output: TerminalOutputState): Promise<void> {
      latest = output;
      revision += 1;
      if (pending !== null) return pending;
      // Publish the pending delivery before drain can return synchronously.
      let resolveDelivery!: () => void;
      let rejectDelivery!: (reason: unknown) => void;
      const delivery = new Promise<void>((resolve, reject) => {
        resolveDelivery = resolve;
        rejectDelivery = reject;
      });
      pending = delivery;
      void drain().then(resolveDelivery, rejectDelivery);
      return delivery;
    },
    dispose() {
      disposed = true;
      latest = null;
    },
  };
}

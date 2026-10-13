import type { OfficePreviewKind } from "./officeArchive";

/** Closing a preview terminates inflation as well as the fetch that supplied it. */
export function checkOfficeArchive(
  bytes: Uint8Array,
  kind: OfficePreviewKind,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./officeArchive.worker.ts", import.meta.url), {
      type: "module",
    });
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const fail = (cause: unknown) => {
      cleanup();
      reject(cause);
    };
    const abort = () => fail(signal.reason);
    const timeout = setTimeout(
      () =>
        fail(
          new Error("This document took too long to validate. Save it to open it in another app."),
        ),
      15_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.addEventListener("error", () =>
      fail(new Error("Could not validate this document. Save it to open it in another app.")),
    );
    worker.addEventListener(
      "message",
      (event: MessageEvent<{ bytes: Uint8Array } | { error: string }>) => {
        if ("error" in event.data) return fail(new Error(event.data.error));
        cleanup();
        resolve(event.data.bytes);
      },
    );
    try {
      worker.postMessage({ bytes, kind }, [bytes.buffer]);
    } catch (cause) {
      fail(cause);
    }
  });
}

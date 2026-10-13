/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated workers post to their owner without a Window target origin. */
import { validateOfficeArchiveContents } from "./officeArchiveContents";
import type { OfficePreviewKind } from "./officeArchive";

self.addEventListener(
  "message",
  (event: MessageEvent<{ bytes: Uint8Array; kind: OfficePreviewKind }>) => {
    const { bytes, kind } = event.data;
    try {
      validateOfficeArchiveContents(bytes, kind);
      self.postMessage({ bytes }, { transfer: [bytes.buffer] });
    } catch (cause) {
      self.postMessage({
        error: cause instanceof Error ? cause.message : "Could not read this document.",
      });
    }
  },
);

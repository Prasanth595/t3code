import {
  decodeFilePreviewText,
  FILE_TEXT_PREVIEW_MAX_BYTES,
  FILE_OFFICE_PREVIEW_MAX_BYTES,
} from "@t3tools/shared/filePreview";

/** Consume only a bounded prefix, even when a host ignores the requested HTTP range. */
export async function readFilePreviewResponse(
  response: Pick<Response, "ok" | "body">,
  signal: AbortSignal,
) {
  return decodeFilePreviewText(
    await readPreviewBytes(response, signal, FILE_TEXT_PREVIEW_MAX_BYTES + 1),
  );
}

/** Office archives need every byte; a truncated ZIP is not a usable preview. */
export async function readOfficePreviewResponse(
  response: Pick<Response, "ok" | "body">,
  signal: AbortSignal,
) {
  const bytes = await readPreviewBytes(response, signal, FILE_OFFICE_PREVIEW_MAX_BYTES + 1);
  if (bytes.length > FILE_OFFICE_PREVIEW_MAX_BYTES)
    throw new Error(
      "Office previews support files up to 10 MB. Save this file to open it in another app.",
    );
  return bytes;
}

async function readPreviewBytes(
  response: Pick<Response, "ok" | "body">,
  signal: AbortSignal,
  limit: number,
) {
  if (!response.ok) {
    // A streamed error body holds the connection open until GC otherwise.
    void response.body?.cancel().catch(() => undefined);
    throw new Error("The file could not be loaded. Reconnect and try again.");
  }
  if (signal.aborted) throw new Error("Preview cancelled.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Streaming file previews are unavailable in this runtime.");
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      if (signal.aborted) throw new Error("Preview cancelled.");
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value.subarray(0, limit - length);
      chunks.push(chunk);
      length += chunk.length;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel();
  }
  if (signal.aborted) throw new Error("Preview cancelled.");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

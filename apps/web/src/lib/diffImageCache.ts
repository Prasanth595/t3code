import { LFS_IMAGE_MAX_BYTES, LFS_IMAGE_MAX_PIXELS } from "@t3tools/shared/gitLfs";
import type { ImageDimensions } from "@t3tools/shared/imageDimensions";

export type DiffImageState =
  | { readonly status: "queued" }
  | { readonly status: "capacity" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "error" };

interface ImageRequest {
  readonly key: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly dimensions?: ImageDimensions;
}

interface Entry {
  request: ImageRequest;
  readonly listeners: Set<(state: DiffImageState) => void>;
  state: DiffImageState;
  controller?: AbortController;
  memoryBytes: number;
}

/** Shared only while mounted; the last consumer releases the download and blob URL. */
export class DiffImageCache {
  readonly #entries = new Map<string, Entry>();
  readonly #maxImages: number;
  readonly #maxMemoryBytes: number;
  readonly #maxConcurrent: number;
  #running = 0;

  constructor(options?: { maxImages?: number; maxMemoryBytes?: number; maxConcurrent?: number }) {
    this.#maxImages = options?.maxImages ?? 12;
    this.#maxMemoryBytes = options?.maxMemoryBytes ?? 160 * 1024 * 1024;
    this.#maxConcurrent = options?.maxConcurrent ?? 2;
  }

  acquire(request: ImageRequest, listener: (state: DiffImageState) => void) {
    let entry = this.#entries.get(request.key);
    if (!entry) {
      entry = { request, listeners: new Set(), state: { status: "queued" }, memoryBytes: 0 };
    }
    this.#entries.set(request.key, entry);
    entry.listeners.add(listener);
    listener(entry.state);
    this.#pump();
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) this.#remove(entry);
      this.#pump();
    };
  }

  retry(key: string, url: string) {
    const entry = this.#entries.get(key);
    if (!entry || entry.state.status !== "error") return;
    entry.request = { ...entry.request, url };
    this.#publish(entry, { status: "queued" });
    this.#pump();
  }

  reject(key: string) {
    const entry = this.#entries.get(key);
    if (!entry) return;
    if (entry.state.status === "ready") URL.revokeObjectURL(entry.state.url);
    entry.controller?.abort();
    entry.memoryBytes = 0;
    this.#publish(entry, { status: "error" });
    this.#pump();
  }

  clear() {
    for (const entry of this.#entries.values()) this.#remove(entry);
  }

  #publish(entry: Entry, state: DiffImageState) {
    entry.state = state;
    for (const listener of entry.listeners) listener(state);
  }

  #remove(entry: Entry) {
    if (this.#entries.get(entry.request.key) !== entry) return;
    this.#entries.delete(entry.request.key);
    entry.controller?.abort();
    if (entry.state.status === "ready") URL.revokeObjectURL(entry.state.url);
  }

  #pump() {
    for (const entry of this.#entries.values()) {
      if (this.#running >= this.#maxConcurrent) return;
      if (
        (entry.state.status !== "queued" && entry.state.status !== "capacity") ||
        entry.listeners.size === 0
      )
        continue;
      const { dimensions, sizeBytes } = entry.request;
      const pixels = dimensions ? dimensions.width * dimensions.height : Infinity;
      // An estimate for the source copy plus one decoded frame, not a browser memory ceiling.
      const memoryBytes = sizeBytes * 2 + pixels * 4;
      if (
        sizeBytes > LFS_IMAGE_MAX_BYTES ||
        pixels > LFS_IMAGE_MAX_PIXELS ||
        memoryBytes > this.#maxMemoryBytes
      ) {
        this.#publish(entry, { status: "error" });
        continue;
      }
      const active = [...this.#entries.values()].filter((entry) => entry.memoryBytes > 0);
      if (
        active.length >= this.#maxImages ||
        active.reduce((bytes, entry) => bytes + entry.memoryBytes, 0) + memoryBytes >
          this.#maxMemoryBytes
      ) {
        if (entry.state.status !== "capacity") this.#publish(entry, { status: "capacity" });
        continue;
      }
      entry.memoryBytes = memoryBytes;
      entry.controller = new AbortController();
      this.#running++;
      this.#publish(entry, { status: "loading" });
      void this.#load(entry).finally(() => {
        this.#running--;
        this.#pump();
      });
    }
  }

  async #load(entry: Entry) {
    const { request, controller } = entry;
    try {
      const response = await fetch(request.url, { signal: controller!.signal });
      if (!response.ok || !response.body) throw new Error("Image unavailable");
      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (controller!.signal.aborted) throw new Error("Image cancelled");
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > request.sizeBytes || bytes > LFS_IMAGE_MAX_BYTES)
            throw new Error("Image exceeds its size limit");
          chunks.push(result.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (bytes !== request.sizeBytes || controller!.signal.aborted)
        throw new Error("Image changed or cancelled");
      if (this.#entries.get(request.key) !== entry || entry.controller !== controller) return;
      const blob = new Blob(chunks, {
        type: response.headers.get("content-type") ?? "application/octet-stream",
      });
      this.#publish(entry, { status: "ready", url: URL.createObjectURL(blob) });
    } catch {
      if (this.#entries.get(request.key) !== entry || entry.controller !== controller) return;
      entry.memoryBytes = 0;
      this.#publish(entry, { status: "error" });
    }
  }
}

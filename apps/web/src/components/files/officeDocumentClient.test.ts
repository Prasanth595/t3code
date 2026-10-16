// @effect-diagnostics nodeBuiltinImport:off - Exercises bounded reads against an actual disposable HTTP response.
import * as NodeHttp from "node:http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createOfficeDocumentClient,
  OFFICE_PREVIEW_MAX_BYTES,
  OFFICE_PREVIEW_TIMEOUT_MS,
  readOfficeDocumentBytes,
} from "./officeDocumentClient";

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  static onPosted: ((worker: TestWorker) => void) | undefined;
  terminate = vi.fn();
  postMessage = vi.fn<
    (message: { id: number; buffer: ArrayBuffer }, transfer: ArrayBuffer[]) => void
  >(() => TestWorker.onPosted?.(this));
  constructor() {
    super();
    TestWorker.instances.push(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  TestWorker.instances = [];
  TestWorker.onPosted = undefined;
});

const source = { name: "book.xlsx", format: "xlsx" as const, file: new Blob(["bytes"]) };
const workerPosted = () =>
  new Promise<TestWorker>((resolve) => {
    TestWorker.onPosted = resolve;
  });

describe("bounded Office document loading", () => {
  it("enforces the limit on actual chunked HTTP bytes without Content-Length", async () => {
    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      for (let index = 0; index < 6; index++) response.write(Buffer.alloc(1024 * 1024));
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP server.");
    try {
      await expect(
        readOfficeDocumentBytes(
          { name: "book.xlsx", format: "xlsx", src: `http://127.0.0.1:${address.port}/book.xlsx` },
          new AbortController().signal,
        ),
      ).rejects.toThrow("5 MiB");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects an oversized local Blob before opening its stream", async () => {
    const file = new Blob([new Uint8Array(OFFICE_PREVIEW_MAX_BYTES + 1)]);
    const stream = vi.spyOn(file, "stream");
    await expect(
      readOfficeDocumentBytes({ ...source, file }, new AbortController().signal),
    ).rejects.toThrow("5 MiB");
    expect(stream).not.toHaveBeenCalled();
  });

  it("cancels a stalled reader when the document closes", async () => {
    let cancelled: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const cancel = vi.fn(() => {
      cancelled?.();
    });
    let reading: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      pull: () => {
        reading?.();
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream)),
    );
    const client = createOfficeDocumentClient({
      name: "book.xlsx",
      format: "xlsx",
      src: "https://environment.test/signed",
    });
    const unsubscribe = client.subscribe(vi.fn());
    await readStarted;
    unsubscribe();
    await cancellation;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("transfers bounded bytes and ignores results after termination", async () => {
    vi.stubGlobal("Worker", TestWorker);
    const client = createOfficeDocumentClient(source);
    const listener = vi.fn();
    const posted = workerPosted();
    const unsubscribe = client.subscribe(listener);
    const worker = await posted;
    const [message, transfer] = worker.postMessage.mock.calls[0]!;
    expect(transfer).toEqual([message.buffer]);
    expect(message.buffer.byteLength).toBe(5);
    unsubscribe();
    const calls = listener.mock.calls.length;
    worker.dispatchEvent(
      new MessageEvent("message", { data: { id: message.id, ok: false, error: "stale" } }),
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it("terminates a stuck parser at the watchdog deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", TestWorker);
    const client = createOfficeDocumentClient(source);
    const posted = workerPosted();
    const unsubscribe = client.subscribe(vi.fn());
    await posted;
    await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_TIMEOUT_MS);
    expect(client.getSnapshot()).toMatchObject({
      status: "error",
      message: expect.stringContaining("timed out"),
    });
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    unsubscribe();
  });
});

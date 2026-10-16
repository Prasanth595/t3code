// @effect-diagnostics nodeBuiltinImport:off - Exercises bounded reads against an actual disposable HTTP response.
import * as NodeHttp from "node:http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createOfficeDocumentClient,
  OFFICE_PREVIEW_MAX_BYTES,
  OFFICE_PREVIEW_TRANSFER_TIMEOUT_MS,
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
const remoteSource = {
  name: "book.xlsx",
  format: "xlsx" as const,
  src: "https://environment.test/signed",
};
const workerPosted = () =>
  new Promise<TestWorker>((resolve) => {
    TestWorker.onPosted = resolve;
  });

function controlledRemoteBody() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let reading: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    pull() {
      reading?.();
    },
    cancel,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(stream)),
  );
  return {
    readStarted,
    cancel,
    complete() {
      controller?.enqueue(new Uint8Array([1, 2, 3]));
      controller?.close();
    },
  };
}

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
    vi.useFakeTimers();
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
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows a transfer beyond fifteen seconds before starting the parser's full watchdog", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", TestWorker);
    const response = controlledRemoteBody();
    const client = createOfficeDocumentClient(remoteSource);
    const posted = workerPosted();
    const unsubscribe = client.subscribe(vi.fn());
    await response.readStarted;
    await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_TIMEOUT_MS + 1000);
    expect(client.getSnapshot()).toEqual({ status: "loading" });
    expect(TestWorker.instances).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    response.complete();
    const worker = await posted;
    expect(new Uint8Array(worker.postMessage.mock.calls[0]![0].buffer)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_TIMEOUT_MS - 1);
    expect(client.getSnapshot()).toEqual({ status: "loading" });
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getSnapshot()).toMatchObject({
      status: "error",
      message: expect.stringContaining("preview timed out"),
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it("aborts a stalled transfer at its finite deadline without starting a parser", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", TestWorker);
    const response = controlledRemoteBody();
    const client = createOfficeDocumentClient(remoteSource);
    const unsubscribe = client.subscribe(vi.fn());
    await response.readStarted;
    await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_TRANSFER_TIMEOUT_MS - 1);
    expect(client.getSnapshot()).toEqual({ status: "loading" });
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getSnapshot()).toMatchObject({
      status: "error",
      message: expect.stringContaining("download timed out"),
    });
    expect(response.cancel).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(TestWorker.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it.each(["success", "worker error"])(
    "releases the parser deadline on %s",
    async (result: string) => {
      vi.useFakeTimers();
      vi.stubGlobal("Worker", TestWorker);
      const client = createOfficeDocumentClient(source);
      const listener = vi.fn();
      const posted = workerPosted();
      const unsubscribe = client.subscribe(listener);
      const worker = await posted;
      expect(vi.getTimerCount()).toBe(1);
      if (result === "success") {
        const document = { kind: "spreadsheet", sheets: [], warnings: [] };
        worker.dispatchEvent(
          new MessageEvent("message", {
            data: { id: worker.postMessage.mock.calls[0]![0].id, ok: true, document },
          }),
        );
        expect(client.getSnapshot()).toEqual({ status: "success", document });
      } else {
        worker.dispatchEvent(new Event("error"));
        expect(client.getSnapshot()).toMatchObject({
          status: "error",
          message: expect.stringContaining("Unable to read"),
        });
      }
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      const calls = listener.mock.calls.length;
      await vi.advanceTimersByTimeAsync(OFFICE_PREVIEW_TRANSFER_TIMEOUT_MS);
      expect(listener).toHaveBeenCalledTimes(calls);
      unsubscribe();
    },
  );

  it("releases the transfer deadline after an HTTP failure", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 403 })),
    );
    let complete: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const client = createOfficeDocumentClient(remoteSource);
    const unsubscribe = client.subscribe(() => {
      if (client.getSnapshot().status === "error") complete?.();
    });
    await completed;
    expect(client.getSnapshot()).toMatchObject({
      status: "error",
      message: expect.stringContaining("HTTP 403"),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it("ignores an earlier transfer completed after unsubscribe and a new subscription", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", TestWorker);
    let resolveEarlier: ((response: Response) => void) | undefined;
    const earlier = new Promise<Response>((resolve) => {
      resolveEarlier = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(earlier)
        .mockResolvedValueOnce(new Response(new Uint8Array([3, 4]))),
    );
    const client = createOfficeDocumentClient(remoteSource);
    const stopEarlier = client.subscribe(vi.fn());
    stopEarlier();
    expect(vi.getTimerCount()).toBe(0);
    const posted = workerPosted();
    const stopCurrent = client.subscribe(vi.fn());
    const worker = await posted;
    resolveEarlier?.(new Response(new Uint8Array([1, 2])));
    await vi.advanceTimersByTimeAsync(0);
    expect(TestWorker.instances).toHaveLength(1);
    expect(new Uint8Array(worker.postMessage.mock.calls[0]![0].buffer)).toEqual(
      new Uint8Array([3, 4]),
    );
    expect(client.getSnapshot()).toEqual({ status: "loading" });
    expect(vi.getTimerCount()).toBe(1);
    stopCurrent();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("transfers bounded bytes and ignores results after termination", async () => {
    vi.useFakeTimers();
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
    expect(vi.getTimerCount()).toBe(0);
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
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });
});

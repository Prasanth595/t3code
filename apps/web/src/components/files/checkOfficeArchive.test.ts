import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { checkOfficeArchive } from "./checkOfficeArchive";

class TestWorker {
  static instances: TestWorker[] = [];
  listeners = new Map<string, (event: { data: unknown }) => void>();
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    TestWorker.instances.push(this);
  }
  addEventListener(name: string, callback: (event: { data: unknown }) => void) {
    this.listeners.set(name, callback);
  }
}
describe("archive worker lifetime", () => {
  beforeEach(() => {
    TestWorker.instances = [];
    vi.stubGlobal("Worker", TestWorker);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("stops actual inflation on cancellation", async () => {
    const controller = new AbortController();
    const result = checkOfficeArchive(new Uint8Array(5), "docx", controller.signal);
    const rejection = expect(result).rejects.toThrow();
    controller.abort();
    await rejection;
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
  it("terminates a stalled validator and offers an external-viewer fallback", async () => {
    const result = checkOfficeArchive(new Uint8Array(5), "xlsx", new AbortController().signal);
    const rejection = expect(result).rejects.toThrow("too long");
    await vi.advanceTimersByTimeAsync(15000);
    await rejection;
    expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
  it("releases the worker after transferring the validated buffer back", async () => {
    const bytes = new Uint8Array(5);
    const result = checkOfficeArchive(bytes, "xlsx", new AbortController().signal);
    const worker = TestWorker.instances[0]!;
    worker.listeners.get("message")!({ data: { bytes } });
    await expect(result).resolves.toBe(bytes);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

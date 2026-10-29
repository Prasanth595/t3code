import { describe, expect, it, vi } from "vite-plus/test";

import { createLocalVoiceTranscriptionClient, hasAudibleSpeech } from "./localVoiceTranscription";
import type {
  LocalVoiceWorkerRequest,
  LocalVoiceWorkerResponse,
} from "./localVoiceTranscriptionProtocol";

class FakeWorker {
  readonly posted: LocalVoiceWorkerRequest[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  postMessage(request: LocalVoiceWorkerRequest) {
    this.posted.push(request);
  }

  terminate() {
    this.terminated = true;
  }

  reply(response: LocalVoiceWorkerResponse) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: response });
  }

  crash() {
    for (const listener of this.listeners.get("error") ?? []) listener(new Event("error"));
  }

  lastRequestId() {
    return this.posted.at(-1)!.id;
  }
}

function createHarness(idleReleaseMs = 1_000) {
  const workers: FakeWorker[] = [];
  const client = createLocalVoiceTranscriptionClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  }, idleReleaseMs);
  return { client, workers };
}

describe("local voice transcription client", () => {
  it("stops a cancelled model load at once and ignores its late reply", async () => {
    const { client, workers } = createHarness();
    const cancelled = new AbortController();
    const loading = client.load(cancelled.signal);
    workers[0]!.reply({ kind: "progress", percent: 40 });
    expect(client.getLoadingPercent()).toBe(40);

    cancelled.abort();

    await expect(loading).rejects.toMatchObject({ code: "cancelled" });
    expect(workers[0]!.terminated).toBe(true);
    expect(client.getLoadingPercent()).toBeNull();
    workers[0]!.reply({ kind: "done", id: workers[0]!.lastRequestId(), text: "" });

    const retry = client.load(new AbortController().signal);
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ kind: "done", id: workers[1]!.lastRequestId(), text: "" });
    await expect(retry).resolves.toBeUndefined();
  });

  it("cancels transcription by terminating the worker so no stale text arrives", async () => {
    const { client, workers } = createHarness();
    const loading = client.load(new AbortController().signal);
    workers[0]!.reply({ kind: "done", id: workers[0]!.lastRequestId(), text: "" });
    await loading;

    const cancelled = new AbortController();
    const transcribing = client.transcribe(new Float32Array(16_000), "fr", cancelled.signal);
    expect(workers[0]!.posted.at(-1)).toMatchObject({ kind: "transcribe", language: "fr" });
    cancelled.abort();

    await expect(transcribing).rejects.toMatchObject({ code: "cancelled" });
    expect(workers[0]!.terminated).toBe(true);
  });

  it("drops a worker that crashed so the next attempt starts clean", async () => {
    const { client, workers } = createHarness();
    const loading = client.load(new AbortController().signal);
    workers[0]!.crash();

    await expect(loading).rejects.toThrow("Voice transcription worker failed.");
    expect(workers[0]!.terminated).toBe(true);
    void client.load(new AbortController().signal);
    expect(workers).toHaveLength(2);
  });

  it("keeps the model while an operation holds it, then frees it once idle", async () => {
    vi.useFakeTimers();
    try {
      const { client, workers } = createHarness(1_000);
      const releaseHold = client.hold();
      const loading = client.load(new AbortController().signal);
      workers[0]!.reply({ kind: "done", id: workers[0]!.lastRequestId(), text: "" });
      await loading;

      vi.advanceTimersByTime(5_000);
      expect(workers[0]!.terminated).toBe(false);

      releaseHold();
      vi.advanceTimersByTime(999);
      expect(workers[0]!.terminated).toBe(false);
      vi.advanceTimersByTime(1);
      expect(workers[0]!.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hasAudibleSpeech", () => {
  it("rejects silence and mic noise but keeps a short utterance in a long clip", () => {
    const noise = Float32Array.from({ length: 16_000 * 10 }, (_, index) =>
      index % 2 === 0 ? 0.001 : -0.001,
    );
    expect(hasAudibleSpeech(new Float32Array(16_000))).toBe(false);
    expect(hasAudibleSpeech(noise)).toBe(false);

    const utterance = noise.slice();
    for (let index = 80_000; index < 83_200; index += 1) {
      utterance[index] = 0.1 * Math.sin(index / 5);
    }
    expect(hasAudibleSpeech(utterance)).toBe(true);
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  FILE_TEXT_PREVIEW_MAX_BYTES,
  FILE_OFFICE_PREVIEW_MAX_BYTES,
} from "@t3tools/shared/filePreview";
import { readFilePreviewResponse, readOfficePreviewResponse } from "./filePreview.ts";

describe("Office binary downloads", () => {
  it("preserves ZIP bytes instead of decoding binary data", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0, 255, 0, 1]);
    expect(
      await readOfficePreviewResponse(new Response(bytes), new AbortController().signal),
    ).toEqual(bytes);
  });
  it("rejects oversized streams, cancels them, and never hands a partial archive to a renderer", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(FILE_OFFICE_PREVIEW_MAX_BYTES));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readOfficePreviewResponse(new Response(body), new AbortController().signal),
    ).rejects.toThrow("10 MB");
    expect(cancelled).toBe(true);
  });
  it("cancels a pending binary download when the preview closes", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const result = readOfficePreviewResponse(new Response(body), controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow("cancelled");
    expect(cancelled).toBe(true);
  });
});

describe("readFilePreviewResponse", () => {
  it("cancels a pending read when its preview closes", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const result = readFilePreviewResponse(new Response(body), controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it("supports native AbortSignal implementations without throwIfAborted", async () => {
    const signal = new AbortController().signal;
    Object.defineProperty(signal, "throwIfAborted", { value: undefined });
    await expect(readFilePreviewResponse(new Response("native text"), signal)).resolves.toEqual({
      text: "native text",
      truncated: false,
    });
  });
  it("reads text and rejects unsuccessful responses", async () => {
    const signal = new AbortController().signal;
    await expect(readFilePreviewResponse(new Response('{"ok":true}'), signal)).resolves.toEqual({
      text: '{"ok":true}',
      truncated: false,
    });
    await expect(
      readFilePreviewResponse(new Response(null, { status: 403 }), signal),
    ).rejects.toThrow("could not be loaded");
  });
  it("cancels a streamed error body instead of leaving it open", async () => {
    const signal = new AbortController().signal;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readFilePreviewResponse(new Response(body, { status: 500 }), signal),
    ).rejects.toThrow("could not be loaded");
    expect(cancelled).toBe(true);
  });

  it("stops consuming an unbounded response and cancels its stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(FILE_TEXT_PREVIEW_MAX_BYTES).fill(97));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await readFilePreviewResponse(new Response(body), new AbortController().signal);
    expect(result.text.length).toBe(FILE_TEXT_PREVIEW_MAX_BYTES);
    expect(result.truncated).toBe(true);
    expect(cancelled).toBe(true);
  });
});

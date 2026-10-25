import { expect, it, vi } from "vite-plus/test";

import { createNativeReviewDiffSourceLoader } from "./nativeReviewDiffSource";
import type { NativeReviewDiffSource } from "./nativeReviewDiffTypes";

const SOURCE = { oldContents: "const before = true;", newContents: "const after = false;" };

vi.mock("expo-file-system", () => ({
  Paths: { document: "test-documents" },
  File: class {
    create() {}
    async write() {}
  },
}));

it("retains fetched stress sources above 500k characters within the aggregate budget", async () => {
  const source = { oldContents: "", newContents: "x".repeat(3_270_000) };
  const fetch = vi.fn(async () => source);
  const load = createNativeReviewDiffSourceLoader(fetch);
  expect(await load("generated.c")).toBe(source);
  expect(await load("generated.c")).toBe(source);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("evicts source text by aggregate size and returns an over-budget response uncached", async () => {
  const source = { oldContents: "", newContents: "x".repeat(4_500_000) };
  const huge = { oldContents: "", newContents: "x".repeat(9_000_000) };
  const fetch = vi.fn(async (id: string) => (id === "huge" ? huge : source));
  const load = createNativeReviewDiffSourceLoader(fetch);
  expect(await load("first")).toBe(source);
  expect(await load("second")).toBe(source);
  expect(await load("first")).toBe(source);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await load("huge")).toBe(huge);
  expect(await load("huge")).toBe(huge);
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(await load("first")).toBe(source);
  expect(fetch).toHaveBeenCalledTimes(5);
});

it("lets later viewport requests retry a failed source fetch", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(SOURCE);
  const load = createNativeReviewDiffSourceLoader(fetch);
  await expect(load("retry.ts")).rejects.toThrow("Offline");
  expect(await load("retry.ts")).toBe(SOURCE);
});

it("serializes RPCs and drops cancelled queued files", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<NativeReviewDiffSource>();
  const fetch = vi.fn((file: string) => {
    if (file !== "active.ts") return Promise.resolve(SOURCE);
    started.resolve();
    return response.promise;
  });
  const load = createNativeReviewDiffSourceLoader(fetch);
  const active = load("active.ts");
  await started.promise;
  const controller = new AbortController();
  const queued = load("cancelled.ts", controller.signal);
  controller.abort();
  expect(await queued).toBeNull();
  expect(fetch.mock.calls).toEqual([["active.ts"]]);
  response.resolve(SOURCE);
  await active;
  await load("next.ts");
  expect(fetch.mock.calls).toEqual([["active.ts"], ["next.ts"]]);
});

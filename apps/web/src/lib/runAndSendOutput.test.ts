import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createRunAndSendOutputRequests } from "./runAndSendOutput";

const environmentId = EnvironmentId.make("environment-a");
const input = {
  threadId: ThreadId.make("thread-a"),
  command: "echo hello",
  cwd: "/original",
};

describe("run and send output requests", () => {
  it("shares rapid clicks and does not restart an accepted fence after remount", async () => {
    const run = createRunAndSendOutputRequests();
    let accept!: (value: boolean) => void;
    const start = vi.fn<Parameters<typeof run>[3]>(
      () => new Promise<boolean>((resolve) => (accept = resolve)),
    );
    const first = run(environmentId, "message-a:block-0", input, start);
    const second = run(environmentId, "message-a:block-0", input, start);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    accept(true);
    expect(await first).toBe(true);
    expect(await run(environmentId, "message-a:block-0", input, start)).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("retries an uncertain transport result with the original terminal and workspace", async () => {
    const run = createRunAndSendOutputRequests();
    const start = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await run(environmentId, "message-a:block-0", input, start);
    await run(environmentId, "message-a:block-0", { ...input, cwd: "/changed" }, start);
    expect(start.mock.calls[1]?.[0]).toEqual(start.mock.calls[0]?.[0]);
    expect(start.mock.calls[1]?.[0].input.cwd).toBe("/original");
    expect(start.mock.calls[1]?.[0].input.terminalId).toMatch(/^run-/);
  });

  it("keeps identical commands in different blocks, messages, threads and environments separate", async () => {
    const run = createRunAndSendOutputRequests();
    const start = vi.fn().mockResolvedValue(true);
    await run(environmentId, "message-a:block-0", input, start);
    await run(environmentId, "message-a:block-1", input, start);
    await run(environmentId, "message-b:block-0", input, start);
    await run(
      environmentId,
      "message-a:block-0",
      { ...input, threadId: ThreadId.make("thread-b") },
      start,
    );
    await run(EnvironmentId.make("environment-b"), "message-a:block-0", input, start);
    expect(new Set(start.mock.calls.map(([request]) => request.input.terminalId)).size).toBe(5);
  });

  it("retains identity after a rejected request and allows a retry", async () => {
    const run = createRunAndSendOutputRequests();
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValueOnce(true);
    await expect(run(environmentId, "message-a:block-0", input, start)).rejects.toThrow(
      "disconnected",
    );
    expect(await run(environmentId, "message-a:block-0", input, start)).toBe(true);
    expect(start.mock.calls[1]?.[0]).toEqual(start.mock.calls[0]?.[0]);
  });

  it("bounds accepted entries while reconstructing their server identity after eviction", async () => {
    const run = createRunAndSendOutputRequests(1);
    const start = vi.fn().mockResolvedValue(true);
    await run(environmentId, "message-a:block-0", input, start);
    await run(environmentId, "message-b:block-0", input, start);
    await run(environmentId, "message-a:block-0", input, start);
    expect(start).toHaveBeenCalledTimes(3);
    expect(start.mock.calls[2]?.[0].input.terminalId).toBe(
      start.mock.calls[0]?.[0].input.terminalId,
    );
  });

  it("preserves workspace metadata through default-capacity eviction and repeated recovery", async () => {
    const run = createRunAndSendOutputRequests();
    const original = { ...input, worktreePath: "/original-worktree" };
    const changed = { ...input, cwd: "/changed", worktreePath: "/changed-worktree" };
    const start = vi.fn().mockResolvedValue(true);
    await run(environmentId, "original", original, start);
    const firstRequest = start.mock.calls[0]?.[0];
    const evict = async (prefix: string) => {
      for (let index = 0; index < 256; index++) {
        await run(environmentId, `${prefix}-${index}`, input, start);
      }
    };
    await evict("first");
    await run(environmentId, "original", changed, start);
    expect(start.mock.lastCall?.[0]).toEqual(firstRequest);
    await evict("second");
    await run(environmentId, "original", changed, start, { retrySendingOutput: true });
    expect(start.mock.lastCall?.[0]).toEqual(firstRequest);
    await run(environmentId, "original", changed, start, { retrySendingOutput: true });
    expect(start.mock.lastCall?.[0]).toEqual(firstRequest);

    await evict("third");
    await run(environmentId, "original", changed, start, { newExecution: true });
    const rerunRequest = start.mock.lastCall?.[0];
    expect(rerunRequest.input).toMatchObject(changed);
    expect(rerunRequest.input.terminalId).not.toBe(firstRequest.input.terminalId);
    await evict("fourth");
    await run(environmentId, "original", original, start, { retrySendingOutput: true });
    expect(start.mock.lastCall?.[0]).toEqual(rerunRequest);
  });

  it("does not evict uncertain or pending requests to make room for a new action", async () => {
    const run = createRunAndSendOutputRequests(1);
    const start = vi.fn().mockResolvedValue(false);
    await run(environmentId, "message-a:block-0", input, start);
    expect(await run(environmentId, "message-b:block-0", input, start)).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    await run(environmentId, "message-a:block-0", input, start);
    expect(start.mock.calls[1]?.[0]).toEqual(start.mock.calls[0]?.[0]);
  });
  it("creates a new execution only after acceptance and an explicit rerun", async () => {
    const run = createRunAndSendOutputRequests();
    const start = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    await run(environmentId, "message-a:block-0", input, start);
    await run(environmentId, "message-a:block-0", { ...input, cwd: "/rerun" }, start, {
      newExecution: true,
    });
    expect(start.mock.calls[1]?.[0].input.terminalId).not.toBe(
      start.mock.calls[0]?.[0].input.terminalId,
    );
    expect(start.mock.calls[1]?.[0].input.cwd).toBe("/rerun");
    // Even an explicit rerun intent cannot replace an uncertain execution.
    await run(environmentId, "message-a:block-0", input, start, { newExecution: true });
    expect(start.mock.calls[2]?.[0]).toEqual(start.mock.calls[1]?.[0]);
    await run(environmentId, "message-a:block-0", input, start);
    expect(start).toHaveBeenCalledTimes(3);
    await run(environmentId, "message-a:block-0", input, start, { newExecution: true });
    expect(new Set(start.mock.calls.map(([request]) => request.input.terminalId)).size).toBe(3);
  });

  it("shares pending reruns and reconstructs the latest identity after eviction", async () => {
    const run = createRunAndSendOutputRequests(1);
    const accepted = vi.fn().mockResolvedValue(true);
    await run(environmentId, "message-a:block-0", input, accepted);
    let accept!: (value: boolean) => void;
    const start = vi.fn<Parameters<typeof run>[3]>(
      () => new Promise<boolean>((resolve) => (accept = resolve)),
    );
    const rerun = run(environmentId, "message-a:block-0", input, start, { newExecution: true });
    expect(run(environmentId, "message-a:block-0", input, start, { newExecution: true })).toBe(
      rerun,
    );
    await Promise.resolve();
    accept(true);
    await rerun;
    await run(environmentId, "message-b:block-0", input, accepted);
    await run(environmentId, "message-a:block-0", input, accepted);
    expect(accepted.mock.calls[2]?.[0]).toEqual(start.mock.calls[0]?.[0]);
    await run(environmentId, "message-b:block-0", input, accepted);
    await run(environmentId, "message-a:block-0", input, accepted, { newExecution: true });
    expect(accepted.mock.calls[4]?.[0].input.terminalId).not.toBe(
      start.mock.calls[0]?.[0].input.terminalId,
    );
  });
  it("forces same-ID dispatch recovery after acceptance while deliberate rerun gets a new ID", async () => {
    const run = createRunAndSendOutputRequests();
    const start = vi.fn().mockResolvedValue(true);
    await run(environmentId, "block", input, start);
    await run(environmentId, "block", input, start);
    expect(start).toHaveBeenCalledTimes(1);
    await run(environmentId, "block", { ...input, cwd: "/changed" }, start, {
      retrySendingOutput: true,
    });
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]?.[0]).toEqual(start.mock.calls[0]?.[0]);
    await run(environmentId, "block", input, start, { newExecution: true });
    expect(start.mock.calls[2]?.[0].input.terminalId).not.toBe(
      start.mock.calls[0]?.[0].input.terminalId,
    );
  });

  it("retains accepted identity and deduplicates pending or failed dispatch retries", async () => {
    const run = createRunAndSendOutputRequests();
    const accepted = vi.fn().mockResolvedValue(true);
    await run(environmentId, "block", input, accepted);
    let reject!: (error: Error) => void;
    const retry = vi.fn<Parameters<typeof run>[3]>(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const pending = run(environmentId, "block", input, retry, { retrySendingOutput: true });
    expect(run(environmentId, "block", input, retry, { retrySendingOutput: true })).toBe(pending);
    await Promise.resolve();
    reject(new Error("dispatch failed"));
    await expect(pending).rejects.toThrow("dispatch failed");
    await run(environmentId, "block", input, accepted, { retrySendingOutput: true });
    expect(accepted.mock.calls[1]?.[0]).toEqual(accepted.mock.calls[0]?.[0]);
    await run(environmentId, "block", input, accepted, { newExecution: true });
    expect(accepted.mock.calls[2]?.[0].input.terminalId).not.toBe(
      accepted.mock.calls[0]?.[0].input.terminalId,
    );
  });
  it("does not evict an accepted execution while dispatch recovery is pending", async () => {
    const run = createRunAndSendOutputRequests(1);
    const start = vi.fn().mockResolvedValue(true);
    await run(environmentId, "block-a", input, start);
    let finish!: (accepted: boolean) => void;
    const retry = vi.fn<Parameters<typeof run>[3]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = run(environmentId, "block-a", input, retry, { retrySendingOutput: true });
    await Promise.resolve();
    expect(await run(environmentId, "block-b", input, start)).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    expect(
      run(environmentId, "block-a", { ...input, cwd: "/changed" }, retry, {
        retrySendingOutput: true,
      }),
    ).toBe(pending);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.calls[0]?.[0]).toEqual(start.mock.calls[0]?.[0]);
    finish(true);
    expect(await pending).toBe(true);
  });
});

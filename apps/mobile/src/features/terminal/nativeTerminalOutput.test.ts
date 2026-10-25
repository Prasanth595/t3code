import { describe, expect, it } from "vite-plus/test";
import {
  applyTerminalAttachStreamEvent,
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";
import { createNativeTerminalOutputWriter } from "./nativeTerminalOutput";

function append(state: typeof EMPTY_TERMINAL_BUFFER_STATE, data: string) {
  return applyTerminalAttachStreamEvent(state, {
    type: "output",
    threadId: "thread",
    terminalId: "terminal",
    data,
  });
}

describe("native terminal output delivery", () => {
  it("feeds only new Unicode output after the retained buffer rolls over", async () => {
    const writes: { data: string; reset: boolean }[] = [];
    const writer = createNativeTerminalOutputWriter(async (data, reset) => {
      writes.push({ data, reset });
      return true;
    });
    let state = append(EMPTY_TERMINAL_BUFFER_STATE, "x".repeat(512 * 1024));
    await writer.update(state.output);
    const chunk = "🙂".repeat(256);
    for (let index = 0; index < 100; index++) {
      state = append(state, chunk);
      await writer.update(state.output);
    }
    expect(writes.filter((write) => write.reset)).toHaveLength(1);
    expect(writes.slice(1).every((write) => write.data === chunk)).toBe(true);
    expect(
      new TextEncoder().encode(
        writes
          .slice(1)
          .map((write) => write.data)
          .join(""),
      ).length,
    ).toBe(100 * 1024);
    expect(state.output.retainedBytes).toBeLessThanOrEqual(512 * 1024);
  });

  it("waits for native acceptance and catches up with a bounded reset when output was missed", async () => {
    const receipt = Promise.withResolvers<boolean>();
    const writes: { data: string; reset: boolean }[] = [];
    const writer = createNativeTerminalOutputWriter((data, reset) => {
      writes.push({ data, reset });
      return writes.length === 1 ? receipt.promise : Promise.resolve(true);
    });
    const first = append(EMPTY_TERMINAL_BUFFER_STATE, "first");
    const delivery = writer.update(first.output);
    const latest = append(first, "z".repeat(600 * 1024));
    void writer.update(latest.output);
    expect(writes).toHaveLength(1);
    receipt.resolve(true);
    await delivery;
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ data: "z".repeat(512 * 1024), reset: true });
    await writer.update(latest.output);
    expect(writes).toHaveLength(2);
  });

  it("delivers output queued between the native receipt and writer finalization", async () => {
    const receipt = Promise.withResolvers<boolean>();
    const writes: string[] = [];
    const writer = createNativeTerminalOutputWriter((data) => {
      writes.push(data);
      return writes.length === 1 ? receipt.promise : Promise.resolve(true);
    });
    const first = append(EMPTY_TERMINAL_BUFFER_STATE, "first");
    const final = append(first, " final");
    const delivery = writer.update(first.output);
    receipt.resolve(true);
    // Queue new output just after the native receipt continuation exits.
    await receipt.promise;
    const finalDelivery = writer.update(final.output);
    await Promise.all([delivery, finalDelivery]);
    expect(writes.join("")).toBe("first final");
  });

  it("does not lose a layout notification while a rejected write is in flight", async () => {
    const receipt = Promise.withResolvers<boolean>();
    const writes: string[] = [];
    const writer = createNativeTerminalOutputWriter((data) => {
      writes.push(data);
      return writes.length === 1 ? receipt.promise : Promise.resolve(true);
    });
    const output = append(EMPTY_TERMINAL_BUFFER_STATE, "ready after layout").output;
    const pending = writer.update(output);
    // onResize can reach JS before the previous native call returns false.
    void writer.update(output);
    receipt.resolve(false);
    await pending;
    expect(writes).toEqual(["ready after layout", "ready after layout"]);
    await writer.update(output);
    expect(writes).toHaveLength(2);
  });

  it("retries an unlaid-out view without losing data and resets on a new generation", async () => {
    const writes: boolean[] = [];
    let ready = false;
    const writer = createNativeTerminalOutputWriter(async (_data, reset) => {
      writes.push(reset);
      return ready;
    });
    const output = append(EMPTY_TERMINAL_BUFFER_STATE, "hello").output;
    await writer.update(output);
    ready = true;
    await writer.update(output);
    await writer.update({
      ...output,
      generation: output.generation + 1,
    } satisfies TerminalOutputState);
    expect(writes).toEqual([true, true, true]);
    writer.dispose();
    await writer.update(output);
    expect(writes).toHaveLength(3);
  });
});

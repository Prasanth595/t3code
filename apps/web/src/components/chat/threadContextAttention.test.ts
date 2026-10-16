import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isContextCommand, useThreadContextAttentionStore } from "./threadContextAttention";

describe("thread context attention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadContextAttentionStore.setState({
      attention: null,
      requestedThreadKeys: new Set(),
      collapsedThreadKeys: new Set(),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expands a collapsed section and ends the pulse after it plays", () => {
    const store = useThreadContextAttentionStore.getState();
    store.toggleCollapsed("env:thread");

    store.requestAttention("env:thread", { highlight: true });

    const state = useThreadContextAttentionStore.getState();
    expect(state.collapsedThreadKeys.has("env:thread")).toBe(false);
    expect(state.requestedThreadKeys.has("env:thread")).toBe(true);
    expect(state.attention).toMatchObject({ threadKey: "env:thread", highlight: true });

    vi.advanceTimersByTime(2_700);
    expect(useThreadContextAttentionStore.getState().attention).toBeNull();
    // The section stays visible for the thread once asked for.
    expect(useThreadContextAttentionStore.getState().requestedThreadKeys.has("env:thread")).toBe(
      true,
    );
  });

  it("lets a newer request outlive the timer of the one it replaced", () => {
    const store = useThreadContextAttentionStore.getState();
    store.requestAttention("env:a", { highlight: true });
    vi.advanceTimersByTime(2_000);
    store.requestAttention("env:b", { highlight: false });
    vi.advanceTimersByTime(1_000);

    expect(useThreadContextAttentionStore.getState().attention).toMatchObject({
      threadKey: "env:b",
    });
  });

  it("recognizes /context only when typed on its own", () => {
    expect(isContextCommand(" /Context ")).toBe(true);
    expect(isContextCommand("/context why so big")).toBe(false);
    expect(isContextCommand("/contexts")).toBe(false);
  });
});

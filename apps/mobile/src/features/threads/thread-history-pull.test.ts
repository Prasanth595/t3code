import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_THREAD_HISTORY_PULL,
  reduceThreadHistoryPull,
  THREAD_HISTORY_PULL_DISTANCE,
} from "./thread-history-pull";

function startAt(offset = 0) {
  return reduceThreadHistoryPull(INITIAL_THREAD_HISTORY_PULL, { type: "start", offset });
}

function move(translationY: number, offset = 0, state = startAt()) {
  return reduceThreadHistoryPull(state, { type: "move", translationY, offset });
}

function release(state: ReturnType<typeof startAt>) {
  return reduceThreadHistoryPull(state, { type: "release" });
}

describe("pulling earlier thread history", () => {
  it("fills proportionally to the finger's distance beyond the history boundary", () => {
    expect(move(THREAD_HISTORY_PULL_DISTANCE / 4).progress).toBe(0.25);
    expect(move(THREAD_HISTORY_PULL_DISTANCE / 2).progress).toBe(0.5);
    expect(move(THREAD_HISTORY_PULL_DISTANCE * 2).progress).toBe(1);
    expect(move(-THREAD_HISTORY_PULL_DISTANCE).progress).toBe(0);
  });

  it("loads once on release, never while the finger is still pulling", () => {
    const armed = move(THREAD_HISTORY_PULL_DISTANCE);
    expect(armed.loadEarlier).toBe(false);
    const released = release(armed);
    expect(released.loadEarlier).toBe(true);
    expect(released.progress).toBe(0);
    expect(release(released).loadEarlier).toBe(false);
  });

  it("does not load for a short pull or after reversing below the threshold", () => {
    expect(release(move(THREAD_HISTORY_PULL_DISTANCE - 1)).loadEarlier).toBe(false);
    const armed = move(THREAD_HISTORY_PULL_DISTANCE);
    const reversed = move(THREAD_HISTORY_PULL_DISTANCE / 2, 0, armed);
    expect(reversed.progress).toBe(0.5);
    expect(release(reversed).loadEarlier).toBe(false);
  });

  it("does not count the distance used to scroll to the history boundary", () => {
    const scrolling = startAt(200);
    expect(move(96, 104, scrolling).progress).toBe(0);
    expect(move(200, 0, scrolling).progress).toBe(0);
    const pulled = move(200 + THREAD_HISTORY_PULL_DISTANCE, 0, scrolling);
    expect(pulled.progress).toBe(1);
    expect(release(pulled).loadEarlier).toBe(true);
  });

  it("requires the list to actually reach the boundary before arming", () => {
    const notAtTop = move(THREAD_HISTORY_PULL_DISTANCE * 2, 20);
    expect(notAtTop.progress).toBe(0);
    expect(release(notAtTop).loadEarlier).toBe(false);
  });

  it("supports iOS bounce offsets and Android's clamped top offset", () => {
    for (const offset of [-48, 0]) {
      const state = move(THREAD_HISTORY_PULL_DISTANCE, offset, startAt(offset));
      expect(state.progress).toBe(1);
      expect(release(state).loadEarlier).toBe(true);
    }
  });

  it("disarms a cancelled gesture and ignores movement without touch-down", () => {
    const armed = move(THREAD_HISTORY_PULL_DISTANCE);
    const cancelled = reduceThreadHistoryPull(armed, { type: "cancel" });
    expect(cancelled.progress).toBe(0);
    expect(release(cancelled).loadEarlier).toBe(false);
    expect(move(THREAD_HISTORY_PULL_DISTANCE, 0, cancelled).progress).toBe(0);
  });
});

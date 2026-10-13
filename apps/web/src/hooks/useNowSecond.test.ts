import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { useNowSecond, useSecondTick } from "./useNowSecond";

function stubVisibility(initial: "visible" | "hidden") {
  const document = Object.assign(new EventTarget(), { visibilityState: initial });
  const window = new EventTarget();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return { document, window };
}

function Probe({ active = true, seen }: { active?: boolean; seen: number[] }) {
  seen.push(useNowSecond(active));
  return null;
}

describe("shared second clock", () => {
  it("feeds every subscriber from one 1s timer and stops it when all leave", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    stubVisibility("visible");
    const seenA: number[] = [];
    const seenB: number[] = [];
    const seenC: number[] = [];
    let a: ReactTestRenderer | undefined;
    let b: ReactTestRenderer | undefined;
    let c: ReactTestRenderer | undefined;
    try {
      act(() => {
        a = create(createElement(Probe, { seen: seenA }));
        b = create(createElement(Probe, { seen: seenB }));
        c = create(createElement(Probe, { seen: seenC }));
      });
      // Three mounted rows, one pending timer.
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(1_000));
      expect(seenA.at(-1)).toBe(1);
      expect(seenB.at(-1)).toBe(1);
      expect(seenC.at(-1)).toBe(1);
      act(() => vi.advanceTimersByTime(2_000));
      expect(seenA.at(-1)).toBe(3);
      expect(vi.getTimerCount()).toBe(1);
      act(() => {
        a?.unmount();
        b?.unmount();
      });
      expect(vi.getTimerCount()).toBe(1);
      act(() => c?.unmount());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      act(() => {
        a?.unmount();
        b?.unmount();
        c?.unmount();
      });
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("pauses while hidden and collapses missed ticks into one update", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { document } = stubVisibility("visible");
    const seen: number[] = [];
    let renderer: ReactTestRenderer | undefined;
    try {
      act(() => {
        renderer = create(createElement(Probe, { seen }));
      });
      act(() => vi.advanceTimersByTime(1_000));
      expect(seen.at(-1)).toBe(1);
      document.visibilityState = "hidden";
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(vi.getTimerCount()).toBe(0);
      const rendersWhileHidden = seen.length;
      act(() => vi.advanceTimersByTime(60_000));
      // Frozen: no wakeups, no commits while hidden.
      expect(seen.length).toBe(rendersWhileHidden);
      document.visibilityState = "visible";
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      // Missed minute collapses into one immediate update; cadence resumes.
      expect(seen.at(-1)).toBe(61);
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(1_000));
      expect(seen.at(-1)).toBe(62);
    } finally {
      act(() => renderer?.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not subscribe while inactive", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    stubVisibility("visible");
    const seen: number[] = [];
    let renderer: ReactTestRenderer | undefined;
    try {
      act(() => {
        renderer = create(createElement(Probe, { seen, active: false }));
      });
      expect(vi.getTimerCount()).toBe(0);
      act(() => vi.advanceTimersByTime(5_000));
      expect(seen).toEqual([0]);
      act(() => renderer?.update(createElement(Probe, { seen })));
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(1_000));
      // Absolute clock: 5s elapsed while inactive + 1s subscribed.
      expect(seen.at(-1)).toBe(6);
    } finally {
      act(() => renderer?.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("fires second ticks without re-rendering the caller", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { document } = stubVisibility("visible");
    const onTick = vi.fn();
    let renders = 0;
    function Silent() {
      renders += 1;
      useSecondTick(true, onTick);
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    try {
      act(() => {
        renderer = create(createElement(Silent));
      });
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(3_000));
      expect(onTick).toHaveBeenCalledTimes(3);
      expect(renders).toBe(1);
      document.visibilityState = "hidden";
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      act(() => vi.advanceTimersByTime(10_000));
      expect(onTick).toHaveBeenCalledTimes(3);
    } finally {
      act(() => renderer?.unmount());
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

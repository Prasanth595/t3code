import { expect, it, vi } from "vite-plus/test";

import { createSourceLineScroll } from "./source-file-scroll";

const ROW_HEIGHT = 24;

// Mirrors VirtualizedList.scrollToIndex for rows without getItemLayout.
function setup({ lineCount = 1_203, measuredThrough = 79 } = {}) {
  vi.useFakeTimers();
  const state = { lineCount, measuredThrough, offset: 0, scrolledToIndex: null as number | null };
  const scrollToIndex = vi.fn((params: { index: number; viewPosition?: number }) => {
    if (params.index < 0 || params.index >= state.lineCount) {
      throw new Error(`scrollToIndex out of range: requested index ${params.index}`);
    }
    if (params.index > state.measuredThrough) {
      scroll.onScrollToIndexFailed({
        index: params.index,
        averageItemLength: ROW_HEIGHT,
        highestMeasuredFrameIndex: state.measuredThrough,
      });
      return;
    }
    state.scrolledToIndex = params.index;
  });
  const scrollToOffset = vi.fn((params: { offset: number }) => {
    state.offset = params.offset;
  });
  const list = {
    get props() {
      return { data: { length: state.lineCount } };
    },
    scrollToIndex,
    scrollToOffset,
  };
  const scroll = createSourceLineScroll(() => list);
  return {
    scroll,
    state,
    scrollToIndex,
    scrollToOffset,
    [Symbol.dispose]: () => vi.useRealTimers(),
  };
}

it("scrolls straight to an already measured line", () => {
  using t = setup();

  t.scroll.scrollToLine(40);

  expect(t.scrollToIndex).toHaveBeenCalledOnce();
  expect(t.scrollToIndex).toHaveBeenCalledWith({ index: 40, animated: false, viewPosition: 0.3 });
  expect(t.scrollToOffset).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("jumps near an unmeasured wrapped line, then lands on it once rows measure", () => {
  using t = setup();

  expect(() => t.scroll.scrollToLine(899)).not.toThrow();
  expect(t.state.offset).toBe(899 * ROW_HEIGHT);
  expect(t.state.scrolledToIndex).toBeNull();

  t.state.measuredThrough = 950;
  vi.runAllTimers();

  expect(t.state.scrolledToIndex).toBe(899);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops retrying when the target never measures", () => {
  using t = setup();

  t.scroll.scrollToLine(899);
  expect(() => vi.runAllTimers()).not.toThrow();

  expect(t.state.scrolledToIndex).toBeNull();
  expect(t.scrollToIndex.mock.calls.length).toBeLessThanOrEqual(10);
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores a line outside the document", () => {
  using t = setup({ lineCount: 12 });

  expect(() => t.scroll.scrollToLine(899)).not.toThrow();
  expect(t.scrollToIndex).not.toHaveBeenCalled();
  expect(t.scrollToOffset).not.toHaveBeenCalled();
});

it("drops a pending retry when the document shrinks or the jump is cancelled", () => {
  using t = setup();

  t.scroll.scrollToLine(899);
  t.state.lineCount = 12;
  t.state.measuredThrough = 11;
  expect(() => vi.runAllTimers()).not.toThrow();
  expect(t.state.scrolledToIndex).toBeNull();

  t.state.lineCount = 1_203;
  t.scroll.scrollToLine(899);
  t.scroll.cancel();
  t.state.measuredThrough = 950;
  vi.runAllTimers();
  expect(t.state.scrolledToIndex).toBeNull();
});

// @effect-diagnostics nodeBuiltinImport:off - reads installed bundles for synchronous VM tests.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

function readBundle(bundle: string) {
  return NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
}

function createList(bundle: string) {
  const source = readBundle(bundle);
  const renderState = source.slice(
    source.indexOf("function setInitialRenderState("),
    source.indexOf("// src/core/finishInitialScroll.ts"),
  );
  const watchdog = source.slice(
    source.indexOf("var INSET_END_SETTLE_WATCHDOG_FRAMES"),
    source.indexOf("function dispatchInitialScroll("),
  );
  const frames: Array<() => void> = [];
  const values = new Map<string, unknown>();
  const scrollTo = vi.fn();
  const onLoad = vi.fn();
  const state = {
    props: { data: ["message"], onLoad, drawDistance: 500 },
    initialScroll: { index: 0, viewPosition: 1 },
    loadStartTime: 0,
    didContainersLayout: true,
    didFinishInitialScroll: true,
    didLoad: false,
    didUserDrag: false,
    scrollLength: 800,
    scroll: 400,
    lastNativeScroll: 200 as number | undefined,
    scrollingTo: undefined as { offset: number } | undefined,
    maintainingScrollAtEnd: false,
    refScroller: { current: { scrollTo } },
  };
  const ctx = { state };
  let contentSize = 1200;
  let inset = 100;
  const api = NodeVM.runInNewContext(
    `${renderState}\n${watchdog}\n({ start: startInsetEndSettleWatchdog, complete: setInitialRenderState })`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      getContentSize: () => contentSize,
      getContentInsetStartAdjustment: () => inset,
      peek$: (_ctx: unknown, key: string) => values.get(key),
      set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
      setAdaptiveRender: vi.fn(),
      scheduleFullDrawDistancePrewarm: vi.fn(),
      INITIAL_DRAW_DISTANCE: 250,
    },
  ) as {
    start: (context: typeof ctx) => void;
    complete: (context: typeof ctx, flags: Record<string, boolean>) => void;
  };
  return {
    state,
    scrollTo,
    onLoad,
    start: () => api.start(ctx),
    complete: () => api.complete(ctx, {}),
    ready: () => values.get("readyToRender") === true,
    resize: (size: number) => {
      contentSize = size;
    },
    setInset: (value: number) => {
      inset = value;
    },
    advance(count: number) {
      for (let index = 0; index < count; index++) {
        const batch = frames.splice(0);
        for (const frame of batch) frame();
      }
    },
  };
}

function createScrollingList(bundle: string) {
  const source = readBundle(bundle);
  const sizing = source.slice(
    source.indexOf("function getId("),
    source.indexOf("// src/utils/helpers.ts"),
  );
  const itemSize = source.slice(
    source.indexOf("function getKnownOrFixedSize("),
    source.indexOf("// src/core/calculateOffsetWithOffsetPosition.ts"),
  );
  const mvcp = source.slice(
    source.indexOf("function requestAdjust("),
    source.indexOf("// src/utils/getScrollVelocity.ts"),
  );
  const contentSizeStart = source.indexOf("function getContentSize(");
  const contentSize = source.slice(contentSizeStart, source.indexOf("\n}", contentSizeStart) + 2);
  const state = {
    props: {
      data: ["first", "second", "target"],
      estimatedItemSize: 100,
      maintainVisibleContentPosition: { data: true, size: true },
    },
    scrollingTo: { index: 2, viewPosition: 1, itemSize: 100, animated: true },
    idsInView: [],
    idCache: [],
    positions: [0, 100, 200],
    indexByKey: new Map([
      [0, 0],
      [1, 1],
      [2, 2],
    ]),
    sizes: new Map([
      [0, 100],
      [1, 100],
      [2, 100],
    ]),
    sizesKnown: new Map<number, number>(),
    averageSizes: {},
    totalSize: 300,
    scroll: 100,
    scrollLength: 100,
    didContainersLayout: true,
    scrollAdjustHandler: { requestAdjust: vi.fn() },
    scheduledWork: { timeout: vi.fn() },
  };
  const values = new Map<string, unknown>([
    ["totalSize", 300],
    ["readyToRender", true],
  ]);
  const ctx = { state, values, scrollAxisGap: 0 };
  const api = NodeVM.runInNewContext(
    `${sizing}\n${itemSize}\n${contentSize}\n${mvcp}\n({ prepareMVCP, setSize, getContentSize })`,
    {
      Platform: {
        OS: bundle.startsWith("react-native.") && !bundle.includes(".web.") ? "ios" : "web",
      },
      IsNewArchitecture: true,
      getContentInsetEnd: () => 0,
      peek$: (_ctx: unknown, key: string) => values.get(key),
      set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
    },
  ) as {
    prepareMVCP: (context: typeof ctx, dataChanged: boolean) => () => void;
    setSize: (context: typeof ctx, key: number, size: number) => void;
    getContentSize: (context: typeof ctx) => number;
  };
  return {
    state,
    prepare: (dataChanged: boolean) => api.prepareMVCP(ctx, dataChanged),
    contentHeight: () => api.getContentSize(ctx),
    resize: (key: number, size: number) => api.setSize(ctx, key, size),
    removeTarget() {
      state.props.data.pop();
      state.positions.pop();
      state.indexByKey.delete(2);
      api.setSize(ctx, 2, 0);
      state.sizes.delete(2);
    },
  };
}

describe.each([
  "react-native.js",
  "react-native.mjs",
  "react.js",
  "react.mjs",
  "react-native.web.js",
  "react-native.web.mjs",
])("scroll target sizing (%s)", (bundle) => {
  it("preserves content height when the last-index scroll target is removed", () => {
    const list = createScrollingList(bundle);
    list.removeTarget();
    expect(list.contentHeight()).toBe(200);

    list.prepare(true)();

    expect(list.contentHeight()).toBe(200);
    expect([...list.state.sizes.keys()]).toEqual([0, 1]);
    expect(list.state.scroll).toBe(100);
  });

  it("adjusts position when a present target with numeric key zero grows", () => {
    const list = createScrollingList(bundle);
    list.state.scrollingTo.index = 0;
    list.state.scrollingTo.viewPosition = 0.5;
    list.state.scroll = 0;
    const maintainPosition = list.prepare(false);

    list.resize(0, 140);
    maintainPosition();

    expect(list.contentHeight()).toBe(340);
    expect(list.state.scroll).toBe(20);
  });
});

describe.each(["react-native.js", "react-native.mjs"])(
  "initial inset end reveal (%s)",
  (bundle) => {
    it("waits for the native offset instead of the optimistic scroll target", () => {
      const list = createList(bundle);
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).toHaveBeenCalledWith({ animated: false, x: 0, y: 400 });
      list.state.lastNativeScroll = 400;
      list.advance(7);
      expect(list.ready()).toBe(true);
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });

    it("gates the seeded contentOffset completion path too", () => {
      const list = createList(bundle);
      list.complete();
      expect(list.ready()).toBe(false);
      list.state.lastNativeScroll = 400;
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("preserves an initial index before the last item", () => {
      const list = createList(bundle);
      list.state.props.data = ["requested message", "later message"];
      list.state.scroll = 200;
      list.complete();
      list.advance(8);
      expect(list.ready()).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
    });

    it("does not count an in-flight scroll as stability", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = 400;
      list.state.scrollingTo = { offset: 400 };
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.scrollingTo = undefined;
      list.state.maintainingScrollAtEnd = true;
      list.advance(8);
      expect(list.ready()).toBe(false);
      list.state.maintainingScrollAtEnd = false;
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("waits for a stable end target even when native scrolling follows each measurement", () => {
      const list = createList(bundle);
      list.start();
      for (let index = 0; index < 10; index++) {
        list.resize(1200 + index * 10);
        list.state.lastNativeScroll = 400 + index * 10;
        list.advance(1);
      }
      expect(list.ready()).toBe(false);
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("accounts for header insets when content is shorter than the full viewport", () => {
      const list = createList(bundle);
      list.resize(780);
      list.state.scroll = -20;
      list.state.lastNativeScroll = -100;
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).toHaveBeenCalledWith({ animated: false, x: 0, y: -20 });
      list.state.lastNativeScroll = -20;
      list.advance(7);
      expect(list.ready()).toBe(true);
    });

    it("keeps the reveal bounded when native events never arrive", () => {
      const list = createList(bundle);
      list.state.lastNativeScroll = undefined;
      list.start();
      list.advance(8);
      expect(list.ready()).toBe(false);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.advance(32);
      expect(list.ready()).toBe(true);
    });

    it("releases control on drag and never starts another initial hold", () => {
      const list = createList(bundle);
      list.start();
      list.state.didUserDrag = true;
      list.advance(1);
      expect(list.ready()).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      list.complete();
      list.start();
      list.advance(20);
      expect(list.state.didUserDrag).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
      expect(list.onLoad).toHaveBeenCalledTimes(1);
    });

    it("preserves a drag that started before initial layout completed", () => {
      const list = createList(bundle);
      list.state.didUserDrag = true;
      list.complete();
      list.advance(1);
      expect(list.ready()).toBe(true);
      expect(list.state.didUserDrag).toBe(true);
      expect(list.scrollTo).not.toHaveBeenCalled();
    });

    it("reveals short content at UIKit's resting offset without awaiting a scroll event", () => {
      const list = createList(bundle);
      list.resize(700);
      list.state.lastNativeScroll = undefined;
      list.complete();
      expect(list.ready()).toBe(true);
      list.advance(10);
      expect(list.scrollTo).not.toHaveBeenCalled();
    });

    it("does not gate empty lists or lists without an automatic header inset", () => {
      const list = createList(bundle);
      list.setInset(0);
      list.complete();
      expect(list.ready()).toBe(true);
      const empty = createList(bundle);
      empty.state.props.data = [];
      empty.complete();
      expect(empty.ready()).toBe(true);
    });
  },
);

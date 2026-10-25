// @effect-diagnostics nodeBuiltinImport:off - exercises the installed list bundles without a native UI.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";

describe.each([
  "react-native.js",
  "react-native.mjs",
  "react-native.web.js",
  "react-native.web.mjs",
  "react.js",
  "react.mjs",
])("fixed row viewability (%s)", (bundle) => {
  function createRow() {
    const source = NodeFS.readFileSync(
      new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
      "utf8",
    );
    const compute = NodeVM.runInNewContext(
      `${source.slice(source.indexOf("function areViewabilityAmountTokensEqual("), source.indexOf("function checkIsViewable("))}\ncomputeViewability`,
      { peek$: () => 0 },
    ) as (
      listState: typeof state,
      listContext: typeof context,
      config: { itemVisiblePercentThreshold: number },
      containerId: number,
      key: string,
      scrollSize: number,
      item: string,
      index: number,
    ) => { size: number; sizeVisible: number };
    const changed = vi.fn();
    const state = {
      sizes: new Map<string, number>(),
      sizesKnown: new Map([["html", 600]]),
      scroll: 300,
      positions: [100],
    };
    const context = {
      mapViewabilityAmountValues: new Map(),
      mapViewabilityAmountCallbacks: new Map([[0, changed]]),
    };
    return {
      state,
      changed,
      compute: () =>
        compute(state, context, { itemVisiblePercentThreshold: 0 }, 0, "html", 800, "html", 0),
    };
  }

  it("keeps an overlapping fixed-height row visible without a measured-size cache entry", () => {
    const row = createRow();
    expect(row.compute()).toMatchObject({ size: 600, sizeVisible: 400 });
    expect(row.changed).toHaveBeenCalledOnce();
    row.state.scroll = 900;
    expect(row.compute().sizeVisible).toBeLessThan(0);
    row.state.scroll = 300;
    expect(row.compute().sizeVisible).toBe(400);
  });

  it("uses measured rows and preserves an explicitly known zero height", () => {
    const row = createRow();
    row.state.sizesKnown.clear();
    row.state.sizes.set("html", 500);
    expect(row.compute().sizeVisible).toBe(300);
    row.state.sizesKnown.set("html", 0);
    expect(row.compute().size).toBe(0);
  });
});

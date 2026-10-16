import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useIsPhoneViewport } from "./useMediaQuery";

describe("useIsPhoneViewport", () => {
  let renderer: ReactTestRenderer | null;
  let viewport: { width: number; height: number; coarse: boolean };
  let orientation: (EventTarget & { type: string }) | undefined;
  let queries: Array<EventTarget & { media: string; matches: boolean }>;

  function evaluate(media: string): boolean {
    if (media === "(orientation: portrait)") return viewport.height >= viewport.width;
    return viewport.width <= 639 && viewport.coarse;
  }

  function Probe() {
    return createElement("output", { value: String(useIsPhoneViewport()) });
  }

  function phone(): boolean {
    return renderer?.root.findByType("output").props.value === "true";
  }

  async function render() {
    await act(() => {
      renderer = create(createElement(Probe));
    });
  }

  async function rotate(width: number, height: number, type?: string) {
    await act(() => {
      Object.assign(viewport, { width, height });
      for (const query of queries) {
        query.matches = evaluate(query.media);
        query.dispatchEvent(new Event("change"));
      }
      if (orientation && type) {
        orientation.type = type;
        orientation.dispatchEvent(new Event("change"));
      }
    });
  }

  beforeEach(() => {
    renderer = null;
    viewport = { width: 390, height: 844, coarse: true };
    orientation = Object.assign(new EventTarget(), { type: "portrait-primary" });
    queries = [];
    vi.stubGlobal("window", {
      get screen() {
        return { orientation };
      },
      matchMedia: (media: string) => {
        const query = Object.assign(new EventTarget(), { media, matches: evaluate(media) });
        queries.push(query);
        return query;
      },
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  it("matches a portrait touch phone", async () => {
    await render();
    expect(phone()).toBe(true);
  });

  it("does not match a narrow window with a mouse", async () => {
    viewport.coarse = false;
    await render();
    expect(phone()).toBe(false);
  });

  it("turns off for a small phone on its side and back on when it is upright", async () => {
    viewport = { width: 360, height: 600, coarse: true };
    await render();
    await rotate(600, 360, "landscape-primary");
    expect(phone()).toBe(false);
    await rotate(360, 600, "portrait-primary");
    expect(phone()).toBe(true);
  });

  it("stays on when a resizes-content keyboard makes the viewport wider than tall", async () => {
    viewport = { width: 412, height: 915, coarse: true };
    await render();
    await rotate(412, 380);
    expect(phone()).toBe(true);
  });

  it("falls back to the orientation query without screen.orientation", async () => {
    orientation = undefined;
    viewport = { width: 360, height: 600, coarse: true };
    await render();
    expect(phone()).toBe(true);
    await rotate(600, 360);
    expect(phone()).toBe(false);
  });
});

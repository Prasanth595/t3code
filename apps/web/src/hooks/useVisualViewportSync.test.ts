import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { measureVisualViewport, useVisualViewportSync } from "./useVisualViewportSync";

describe("measureVisualViewport", () => {
  it("reports no keyboard when the visible area fills the layout viewport", () => {
    expect(measureVisualViewport(844, { height: 844, offsetTop: 0, scale: 1 })).toEqual({
      height: 844,
      offsetTop: 0,
      keyboardInset: 0,
      keyboardOpen: false,
    });
  });

  it("measures an iOS keyboard that overlays the page without panning", () => {
    expect(measureVisualViewport(844, { height: 508, offsetTop: 0, scale: 1 })).toEqual({
      height: 508,
      offsetTop: 0,
      keyboardInset: 336,
      keyboardOpen: true,
    });
  });

  it("keeps the shell on the visible area after iOS pans to reveal the field", () => {
    expect(measureVisualViewport(844, { height: 508, offsetTop: 336, scale: 1 })).toEqual({
      height: 508,
      offsetTop: 336,
      keyboardInset: 0,
      keyboardOpen: true,
    });
  });

  it("treats a Chromium resizes-content keyboard as a plain smaller viewport", () => {
    expect(measureVisualViewport(444, { height: 444, offsetTop: 0, scale: 1 })).toMatchObject({
      height: 444,
      keyboardInset: 0,
    });
  });

  it("ignores toolbar collapse that is too small to be a keyboard", () => {
    expect(measureVisualViewport(844, { height: 770, offsetTop: 0, scale: 1 })?.keyboardOpen).toBe(
      false,
    );
  });

  it("stands down while the user is pinch-zoomed", () => {
    expect(measureVisualViewport(844, { height: 300, offsetTop: 120, scale: 2 })).toBeNull();
  });
});

describe("useVisualViewportSync lifecycle", () => {
  let renderer: ReactTestRenderer | null;
  let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
  let browser: EventTarget & {
    innerHeight: number;
    innerWidth: number;
    visualViewport: typeof viewport;
  };
  let root: { style: CSSStyleDeclaration; dataset: DOMStringMap };

  function Probe({ enabled }: { enabled: boolean }) {
    useVisualViewportSync(enabled);
    return null;
  }

  async function render(enabled = true) {
    await act(() => {
      if (renderer) renderer.update(createElement(Probe, { enabled }));
      else renderer = create(createElement(Probe, { enabled }));
    });
  }

  function resize(height: number, offsetTop = 0, layoutHeight = 844) {
    Object.assign(viewport, { height, offsetTop });
    browser.innerHeight = layoutHeight;
    viewport.dispatchEvent(new Event("resize"));
    browser.dispatchEvent(new Event("resize"));
  }

  beforeEach(() => {
    renderer = null;
    viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    browser = Object.assign(new EventTarget(), {
      innerHeight: 844,
      innerWidth: 390,
      visualViewport: viewport,
    });
    const properties = new Map<string, string>();
    root = {
      style: {
        setProperty: (key: string, value: string) => properties.set(key, value),
        removeProperty: (key: string) => properties.delete(key),
        getPropertyValue: (key: string) => properties.get(key) ?? "",
      } as unknown as CSSStyleDeclaration,
      dataset: {},
    };
    vi.stubGlobal("window", browser);
    vi.stubGlobal("document", { documentElement: root });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  it.each(["overlay", "resize"])("survives repeated %s keyboard cycles", async (mode) => {
    await render();
    for (let cycle = 0; cycle < 5; cycle++) {
      resize(444, mode === "overlay" ? 200 : 0, mode === "resize" ? 444 : 844);
      expect(root.dataset.keyboardOpen).toBe(mode === "overlay" ? "true" : undefined);
      expect(root.style.getPropertyValue("--app-viewport-height")).toBe("444px");
      resize(844);
      expect(root.dataset.keyboardOpen).toBeUndefined();
      expect(root.style.getPropertyValue("--app-viewport-offset-top")).toBe("0px");
    }
  });

  it("follows rotation with a Chromium keyboard already open", async () => {
    await render();
    resize(444, 0, 444);
    browser.innerWidth = 844;
    resize(190, 0, 190);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("190px");
    expect(root.style.getPropertyValue("--app-viewport-offset-top")).toBe("0px");
    resize(390, 0, 390);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("390px");
    expect(root.dataset.keyboardOpen).toBeUndefined();
  });

  it("updates keyboard state even when the published geometry does not change", async () => {
    browser.innerHeight = 600;
    Object.assign(viewport, { height: 500, offsetTop: 200 });
    await render();
    expect(root.dataset.keyboardOpen).toBeUndefined();
    resize(500, 200, 650);
    expect(root.dataset.keyboardOpen).toBe("true");
  });

  it("releases the document lock for zoom, route unmount, and desktop", async () => {
    await render();
    viewport.scale = 2;
    resize(300, 120);
    expect(root.dataset.viewportSync).toBeUndefined();
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("");
    viewport.scale = 1;
    resize(508, 336);
    expect(root.dataset.viewportSync).toBe("true");
    await render(false);
    expect(root.dataset).toEqual({});
    resize(444);
    expect(root.dataset).toEqual({});
    await render();
    await act(() => renderer?.unmount());
    renderer = null;
    resize(844);
    expect(root.dataset).toEqual({});
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("");
  });
});

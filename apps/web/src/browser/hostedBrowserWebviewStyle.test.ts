import { describe, expect, it } from "vite-plus/test";

import {
  HIDDEN_BROWSER_WEBVIEW_OFFSET,
  resolveHostedBrowserWebviewRadius,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";

describe("resolveHostedBrowserWebviewWrapperStyle", () => {
  it("places an active webview on its presented surface", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        renderingActive: true,
        rect: { x: 12, y: 34, width: 800, height: 600 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toEqual({
      left: 12,
      top: 34,
      width: 800,
      height: 600,
      zIndex: 30,
      pointerEvents: "auto",
    });
  });

  it("clips a floating webview to the mini-player frame", () => {
    expect(
      resolveHostedBrowserWebviewWrapperStyle({
        active: true,
        renderingActive: true,
        cornerRadius: 12,
        zIndex: 48,
        rect: { x: 12, y: 34, width: 360, height: 203 },
        hiddenSize: { width: 1280, height: 800 },
      }),
    ).toMatchObject({
      left: 12,
      top: 34,
      width: 360,
      height: 203,
      borderRadius: 12,
      zIndex: 48,
    });
  });

  it("suspends painting for an inactive webview", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: false,
      rect: { x: 12, y: 34, width: 800, height: 600 },
      hiddenSize: { width: 393, height: 852 },
    });

    expect(style).toEqual({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      width: 393,
      height: 852,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "hidden",
    });
  });

  it("keeps an active background task paintable behind the app", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: true,
      rect: null,
      hiddenSize: { width: 1280, height: 800 },
    });

    expect(style).toEqual({
      left: 0,
      top: 0,
      width: 1280,
      height: 800,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "visible",
    });
  });

  it("keeps an inactive webview paintable without marking it as rendering-active", () => {
    const style = resolveHostedBrowserWebviewWrapperStyle({
      active: false,
      renderingActive: false,
      keepPaintableWhenInactive: true,
      rect: null,
      hiddenSize: { width: 1280, height: 800 },
    });

    expect(style).toEqual({
      left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
      width: 1280,
      height: 800,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "visible",
    });
  });
});

describe("resolveHostedBrowserWebviewRadius", () => {
  const canvas = { canvasWidth: 360, canvasHeight: 203 };

  it("rounds a guest that fills the wrapper", () => {
    expect(
      resolveHostedBrowserWebviewRadius({
        cornerRadius: 12,
        layout: {
          ...canvas,
          viewportX: 0,
          viewportY: 0,
          viewportWidth: 360,
          viewportHeight: 203,
          viewportScale: 1,
        },
      }),
    ).toBe(12);
  });

  it("keeps the on-screen radius when the guest is scaled down to fit", () => {
    expect(
      resolveHostedBrowserWebviewRadius({
        cornerRadius: 12,
        layout: {
          ...canvas,
          viewportX: 0,
          viewportY: 0,
          viewportWidth: 360,
          viewportHeight: 203,
          viewportScale: 0.5,
        },
      }),
    ).toBe(24);
  });

  it("rounds a guest that is letterboxed on one axis but still reaches the curve", () => {
    expect(
      resolveHostedBrowserWebviewRadius({
        cornerRadius: 12,
        layout: {
          ...canvas,
          viewportX: 0,
          viewportY: 6,
          viewportWidth: 360,
          viewportHeight: 191,
          viewportScale: 1,
        },
      }),
    ).toBe(12);
  });

  it("leaves a guest square once it is inset clear of the curve", () => {
    expect(
      resolveHostedBrowserWebviewRadius({
        cornerRadius: 12,
        layout: {
          ...canvas,
          viewportX: 6,
          viewportY: 8,
          viewportWidth: 348,
          viewportHeight: 187,
          viewportScale: 1,
        },
      }),
    ).toBeUndefined();
  });

  it("leaves a panel browser square", () => {
    expect(
      resolveHostedBrowserWebviewRadius({
        cornerRadius: 0,
        layout: {
          ...canvas,
          viewportX: 0,
          viewportY: 0,
          viewportWidth: 360,
          viewportHeight: 203,
          viewportScale: 1,
        },
      }),
    ).toBeUndefined();
  });
});

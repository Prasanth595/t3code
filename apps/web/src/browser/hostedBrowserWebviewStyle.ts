import type { BrowserSurfaceRect } from "./browserSurfaceStore";
import type { BrowserViewportLayout } from "./browserViewportLayout";

export interface HostedBrowserWebviewSize {
  readonly width: number;
  readonly height: number;
}

export interface HostedBrowserWebviewWrapperStyle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
  readonly pointerEvents: "auto" | "none";
  readonly borderRadius?: number;
  readonly visibility?: "hidden" | "visible";
}

export const HIDDEN_BROWSER_WEBVIEW_OFFSET = -100_000;

export function resolveHostedBrowserWebviewWrapperStyle(input: {
  readonly active: boolean;
  readonly renderingActive: boolean;
  readonly keepPaintableWhenInactive?: boolean;
  readonly cornerRadius?: number;
  readonly zIndex?: number;
  readonly rect: BrowserSurfaceRect | null;
  readonly hiddenSize: HostedBrowserWebviewSize;
}): HostedBrowserWebviewWrapperStyle {
  const {
    active,
    cornerRadius = 0,
    hiddenSize,
    keepPaintableWhenInactive = false,
    rect,
    renderingActive,
    zIndex = 30,
  } = input;
  if (active && rect) {
    return {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      zIndex,
      pointerEvents: "auto",
      ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
    };
  }

  if (renderingActive) {
    // Electron stops compositing a guest that is fully outside the window, even
    // when background throttling is disabled. Keep capture-active guests inside
    // the viewport but behind the app so recordings receive complete frames.
    return {
      left: 0,
      top: 0,
      width: hiddenSize.width,
      height: hiddenSize.height,
      zIndex: -1,
      pointerEvents: "none",
      visibility: "visible",
    };
  }

  return {
    left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    width: hiddenSize.width,
    height: hiddenSize.height,
    zIndex: -1,
    pointerEvents: "none",
    visibility: keepPaintableWhenInactive ? "visible" : "hidden",
  };
}

/**
 * The radius to put on the `<webview>` itself. Electron composites the guest
 * (and, on Windows, its scrollbars) apart from the DOM, so the wrapper's
 * `overflow: hidden` does not reliably round it. Only a guest with a corner
 * inside the wrapper's curve needs it; a letterboxed one sits clear of it. The
 * radius is divided by the scale so it still reads as `cornerRadius` once the
 * guest is scaled down to fit.
 */
export function resolveHostedBrowserWebviewRadius(input: {
  readonly cornerRadius: number;
  readonly layout: Pick<
    BrowserViewportLayout,
    | "canvasWidth"
    | "canvasHeight"
    | "viewportX"
    | "viewportY"
    | "viewportWidth"
    | "viewportHeight"
    | "viewportScale"
  >;
}): number | undefined {
  const { cornerRadius: radius, layout } = input;
  if (radius <= 0) return undefined;
  const left = layout.viewportX;
  const top = layout.viewportY;
  const right = layout.canvasWidth - (layout.viewportX + layout.viewportWidth);
  const bottom = layout.canvasHeight - (layout.viewportY + layout.viewportHeight);
  // A square corner inset (a, b) from a rounded corner pokes out of its arc
  // when it lies farther than `radius` from the arc's centre.
  const pokesOut = (a: number, b: number) =>
    a < radius && b < radius && (radius - a) ** 2 + (radius - b) ** 2 > radius ** 2;
  return pokesOut(left, top) ||
    pokesOut(right, top) ||
    pokesOut(left, bottom) ||
    pokesOut(right, bottom)
    ? radius / layout.viewportScale
    : undefined;
}

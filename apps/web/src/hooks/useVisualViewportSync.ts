import { useEffect } from "react";

/** Below this much lost height we treat the change as browser chrome, not a keyboard. */
export const KEYBOARD_OPEN_THRESHOLD_PX = 120;

export interface VisualViewportMetrics {
  /** Height of the area the user can actually see, keyboard excluded. */
  height: number;
  /** How far the browser has panned the visible area down the layout viewport (iOS does this on focus). */
  offsetTop: number;
  /** Layout height hidden under the on-screen keyboard. */
  keyboardInset: number;
  keyboardOpen: boolean;
}

interface VisualViewportLike {
  height: number;
  offsetTop: number;
  scale: number;
}

/**
 * Measures the visible area against the layout viewport. Returns null while the user is
 * pinch-zoomed, where the visual viewport says nothing about the keyboard.
 *
 * iOS Safari ignores `interactive-widget=resizes-content`, so its keyboard shrinks only the
 * visual viewport and pans it (`offsetTop`) to reveal the focused field. Chromium honours the
 * meta tag and shrinks the layout viewport too, which yields a zero inset here.
 */
export function measureVisualViewport(
  layoutHeight: number,
  viewport: VisualViewportLike,
): VisualViewportMetrics | null {
  if (viewport.scale > 1.01) return null;
  const height = Math.round(viewport.height);
  const offsetTop = Math.max(0, Math.round(viewport.offsetTop));
  const lostHeight = Math.max(0, Math.round(layoutHeight) - height);
  return {
    height,
    offsetTop,
    keyboardInset: Math.max(0, lostHeight - offsetTop),
    keyboardOpen: lostHeight > KEYBOARD_OPEN_THRESHOLD_PX,
  };
}

const HEIGHT_VAR = "--app-viewport-height";
const OFFSET_VAR = "--app-viewport-offset-top";
const INSET_VAR = "--keyboard-inset";

function clearViewportSync(root: HTMLElement) {
  root.style.removeProperty(HEIGHT_VAR);
  root.style.removeProperty(OFFSET_VAR);
  root.style.removeProperty(INSET_VAR);
  delete root.dataset.keyboardOpen;
  delete root.dataset.viewportSync;
}

/**
 * Pins the app shell to the visible area on phones: the header stays at the top, the composer
 * sits directly on the keyboard, and the page itself never scrolls.
 * Writes `--app-viewport-height` and `--app-viewport-offset-top` for the shell, `--keyboard-inset`
 * for anything that needs it, and `data-viewport-sync` / `data-keyboard-open` on `<html>`.
 */
export function useVisualViewportSync(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let last = "";

    const apply = () => {
      const metrics = measureVisualViewport(window.innerHeight, viewport);
      if (!metrics) {
        last = "";
        clearViewportSync(root);
        return;
      }
      const key = `${metrics.height}:${metrics.offsetTop}:${metrics.keyboardInset}:${metrics.keyboardOpen}`;
      if (key === last) return;
      last = key;
      root.dataset.viewportSync = "true";
      root.style.setProperty(HEIGHT_VAR, `${metrics.height}px`);
      root.style.setProperty(OFFSET_VAR, `${metrics.offsetTop}px`);
      root.style.setProperty(INSET_VAR, `${metrics.keyboardInset}px`);
      if (metrics.keyboardOpen) root.dataset.keyboardOpen = "true";
      else delete root.dataset.keyboardOpen;
    };

    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      clearViewportSync(root);
    };
  }, [enabled]);
}

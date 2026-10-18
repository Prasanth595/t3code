import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { onTestFinished } from "vite-plus/test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Whether one media query, `(min-width: Npx)` and `(max-width: Npx)` joined by `and`, holds. */
const matchesWidth = (query: string, widthPx: number): boolean =>
  query.split(/\s+and\s+/).every((part) => {
    const match = /^\(\s*(min|max)-width:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(part.trim());
    if (match === null) return false;
    const limit = Number(match[2]);
    return match[1] === "min" ? widthPx >= limit : widthPx <= limit;
  });

let restoreViewport: (() => void) | null = null;

/**
 * Makes `window.matchMedia` answer for a viewport `widthPx` wide, until `restore` (or the next
 * `viewport`, which restores first). The code under test asks `matchMedia` for its breakpoints, and
 * the browser's own window is whatever size the runner gave it.
 */
export function viewport(widthPx: number): () => void {
  restoreViewport?.();
  const own = Object.getOwnPropertyDescriptor(window, "matchMedia");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matchesWidth(query, widthPx),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  const restore = () => {
    if (restoreViewport !== restore) return;
    restoreViewport = null;
    if (own === undefined) Reflect.deleteProperty(window, "matchMedia");
    else Object.defineProperty(window, "matchMedia", own);
  };
  restoreViewport = restore;
  return restore;
}

/**
 * Sets what `document.visibilityState` says, for the live-refresh policy, which polls only while the
 * window shows. Undo it with `resetDocumentVisible`.
 */
export function setDocumentVisible(visible: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
}

export function resetDocumentVisible(): void {
  Reflect.deleteProperty(document, "visibilityState");
}

/** Renders `element` at 1280 px wide. */
export const render = (element: ReactElement) => renderAt(1280, element);

/**
 * Renders `element` into the document in a viewport `widthPx` wide and returns helpers to read the
 * DOM it made. The viewport stays until `unmount`, the next render, or the end of the test, since a
 * later update still asks it.
 */
export async function renderAt(widthPx: number, element: ReactElement) {
  const restore = viewport(widthPx);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    container.remove();
    restore();
  };
  onTestFinished(unmount);
  await act(async () => root.render(element));
  const all: {
    <K extends keyof HTMLElementTagNameMap>(selector: K): Array<HTMLElementTagNameMap[K]>;
    (selector: string): Array<HTMLElement>;
  } = (selector: string) => Array.from(container.querySelectorAll<HTMLElement>(selector));
  return {
    container,
    /** All rendered text, concatenated. */
    text: () => container.textContent ?? "",
    /** Elements matching `selector` (`a`, `button`, `[aria-label="x"]`, ...). */
    all,
    /** The `button` whose text is `label`. */
    button: (label: string): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label),
    /** Clicks `element`, as the user would, and lets React settle. */
    click: (element: HTMLElement) =>
      act(async () => {
        element.click();
      }),
    /** Renders `next` in place of the element, keeping the root and its state. */
    rerender: (next: ReactElement) => act(async () => root.render(next)),
    unmount,
  };
}

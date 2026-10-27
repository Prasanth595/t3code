import type { ReactElement } from "react";

import { act, render as renderScreen } from "../../test/render";

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
 * Makes `window.matchMedia` answer for a viewport `widthPx` wide, until disposed (or the next
 * `viewport`, which restores first). The code under test asks `matchMedia` for its breakpoints, and
 * the browser's own window is whatever size the runner gave it.
 */
function viewport(widthPx: number): Disposable {
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
  return { [Symbol.dispose]: restore };
}

/**
 * Sets what `document.visibilityState` says, for the live-refresh policy, which polls only while the
 * window shows. Disposing it gives the document its own answer back.
 */
export function setDocumentVisible(visible: boolean): Disposable {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  return { [Symbol.dispose]: () => void Reflect.deleteProperty(document, "visibilityState") };
}

/** Renders `element` at 1280 px wide. */
export const render = (element: ReactElement) => renderAt(1280, element);

/**
 * Renders `element` into the document in a viewport `widthPx` wide and returns helpers to read the
 * DOM it made. Acquire it with `await using`: the viewport stays until `unmount`, the next render,
 * or dispose, since a later update still asks it.
 */
export async function renderAt(widthPx: number, element: ReactElement) {
  const size = viewport(widthPx);
  // The factory pages mock the router module themselves, so a test router would fight those mocks.
  const screen = await renderScreen(element, { router: false }).catch((error: unknown) => {
    size[Symbol.dispose]();
    throw error;
  });
  const { container } = screen;
  const all: {
    <K extends keyof HTMLElementTagNameMap>(selector: K): Array<HTMLElementTagNameMap[K]>;
    (selector: string): Array<HTMLElement>;
  } = (selector: string) => Array.from(container.querySelectorAll<HTMLElement>(selector));
  const dispose = async () => {
    try {
      await screen[Symbol.asyncDispose]();
    } finally {
      size[Symbol.dispose]();
    }
  };
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
    click: (element: HTMLElement) => act(() => element.click()),
    /** Renders `next` in place of the element, keeping the root and its state. */
    rerender: (next: ReactElement) => screen.rerender(next),
    /** Unmounts and removes the container early; dispose then does nothing more. */
    unmount: dispose,
    [Symbol.asyncDispose]: dispose,
  };
}

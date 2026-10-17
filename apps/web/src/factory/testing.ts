import { act, type ReactElement } from "react";
import { onTestFinished } from "vite-plus/test";
import {
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
  type ReactTestRendererJSON,
  type ReactTestRendererNode,
} from "react-test-renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flatten = (
  node: ReactTestRendererNode | ReadonlyArray<ReactTestRendererNode> | null,
): string => {
  if (node === null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join("");
  return flatten((node as ReactTestRendererJSON).children);
};

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
 * Gives the code under test a `window` whose `matchMedia` answers for a viewport `widthPx` wide,
 * until `restore` (or the next `viewport`, which restores first). Nothing else of a window exists
 * but an event target, which the live-refresh policy listens on.
 */
export function viewport(widthPx: number): () => void {
  restoreViewport?.();
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const previous = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: Object.assign(new EventTarget(), {
      matchMedia: (query: string) => ({
        matches: matchesWidth(query, widthPx),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    }),
  });
  const restore = () => {
    if (restoreViewport !== restore) return;
    restoreViewport = null;
    if (hadWindow) {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: previous,
      });
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  };
  restoreViewport = restore;
  return restore;
}

/** Renders `element` at 1280 px wide. */
export const render = (element: ReactElement) => renderAt(1280, element);

/**
 * Renders `element` in a viewport `widthPx` wide and returns the renderer with helpers to read it.
 * The viewport stays until `unmount`, the next render, or the end of the test, since a later
 * update still asks it.
 */
export async function renderAt(widthPx: number, element: ReactElement) {
  const restore = viewport(widthPx);
  onTestFinished(restore);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  return {
    renderer,
    /** All rendered text, concatenated. */
    text: () => flatten(renderer.toJSON()),
    /** Host elements of `type` (`a`, `button`, ...). */
    all: (type: string): ReadonlyArray<ReactTestInstance> =>
      renderer.root.findAllByType(type as never),
    /** The `button` whose text is `label`. */
    button: (label: string): ReactTestInstance | undefined =>
      renderer.root
        .findAllByType("button" as never)
        .find((b) => flatten(b.children as never) === label),
    unmount: async () => {
      await act(() => renderer.unmount());
      restore();
    },
  };
}

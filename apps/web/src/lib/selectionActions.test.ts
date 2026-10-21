import { expect, it, vi } from "vite-plus/test";

import { observeSelectionActions } from "./selectionActions";

function event(type: string, values: Record<string, unknown> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), values);
}

function createSelectionSurface() {
  vi.useFakeTimers();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const view = Object.assign(new EventTarget(), {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const document = Object.assign(new EventTarget(), { defaultView: view, activeElement: null });
  const element = Object.assign(new EventTarget(), {
    ownerDocument: document,
    contains: (target: unknown): boolean => target === element,
    closest: () => null,
  });
  const onSelection = vi.fn();
  const onReposition = vi.fn();
  const onDismiss = vi.fn();
  const actions = observeSelectionActions({
    element: element as unknown as HTMLElement,
    onSelection,
    onReposition,
    onDismiss,
  });
  return {
    element,
    view,
    onSelection,
    onReposition,
    onDismiss,
    selectWithPointer() {
      const down = event("pointerdown", { button: 0, isPrimary: true });
      Object.defineProperty(down, "target", { value: element });
      document.dispatchEvent(down);
      element.dispatchEvent(down);
      view.dispatchEvent(event("pointerup", { button: 0, isPrimary: true }));
      view.dispatchEvent(event("mouseup", { button: 0, detail: 1, clientX: 300, clientY: 200 }));
    },
    key(key: string) {
      document.dispatchEvent(event("keydown", { key }));
    },
    selectionChanged: actions.selectionChanged,
    flush() {
      vi.advanceTimersByTime(0);
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    },
    [Symbol.dispose]() {
      actions.dispose();
      vi.useRealTimers();
    },
  };
}

it.each(["timer", "frame"])("preserves a pending selection %s when scrolling starts", (stage) => {
  using surface = createSelectionSurface();
  surface.selectWithPointer();
  if (stage === "frame") vi.advanceTimersByTime(0);
  surface.element.dispatchEvent(event("scroll"));
  surface.flush();
  expect(surface.onSelection).toHaveBeenCalledExactlyOnceWith(null);

  surface.key("ArrowRight");
  surface.selectionChanged();
  if (stage === "frame") vi.advanceTimersByTime(0);
  surface.element.dispatchEvent(event("scroll"));
  surface.flush();
  expect(surface.onSelection).toHaveBeenCalledTimes(2);
  expect(surface.onSelection).toHaveBeenLastCalledWith(null);
});

it("repositions the existing quote until Escape dismisses it", () => {
  using surface = createSelectionSurface();
  surface.selectWithPointer();
  surface.flush();
  surface.onDismiss.mockClear();
  surface.element.dispatchEvent(event("scroll"));
  surface.view.dispatchEvent(event("resize"));
  expect(surface.onReposition).toHaveBeenCalledTimes(2);
  expect(surface.onSelection).toHaveBeenCalledOnce();
  expect(surface.onDismiss).not.toHaveBeenCalled();

  surface.key("Escape");
  surface.element.dispatchEvent(event("scroll"));
  expect(surface.onReposition).toHaveBeenCalledTimes(2);
});

it("window blur cancels repositioning without recapturing the quote", () => {
  using surface = createSelectionSurface();
  surface.selectWithPointer();
  surface.flush();
  surface.onDismiss.mockClear();
  surface.view.dispatchEvent(event("blur"));
  surface.element.dispatchEvent(event("scroll"));
  surface.flush();
  expect(surface.onDismiss).toHaveBeenCalledWith("cancel");
  expect(surface.onReposition).not.toHaveBeenCalled();
  expect(surface.onSelection).toHaveBeenCalledOnce();
});

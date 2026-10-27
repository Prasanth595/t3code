import { describe, expect, it, vi } from "vite-plus/test";

import { startSidebarTouchHold } from "./Sidebar.touch";

function pointer(type: string, values: Partial<PointerEvent> = {}) {
  return Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1,
    clientX: 30,
    clientY: 60,
    ...values,
  }) as PointerEvent;
}

function setup() {
  vi.useFakeTimers();
  const document = Object.assign(new EventTarget(), { defaultView: new EventTarget() });
  const row = { ownerDocument: document } as unknown as HTMLElement;
  const onHold = vi.fn();
  const dispose = startSidebarTouchHold(row, pointer("pointerdown"), onHold);
  return {
    document,
    onHold,
    dispose,
    [Symbol.dispose]: () => {
      dispose();
      vi.useRealTimers();
    },
  };
}

describe("sidebar touch hold", () => {
  it("opens the thread menu once at the held position, tolerating finger jitter", () => {
    using gesture = setup();
    gesture.document.dispatchEvent(pointer("pointermove", { clientX: 33, clientY: 64 }));
    vi.advanceTimersByTime(499);
    expect(gesture.onHold).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(gesture.onHold).toHaveBeenCalledExactlyOnceWith({ x: 30, y: 60 });
    vi.advanceTimersByTime(1000);
    expect(gesture.onHold).toHaveBeenCalledOnce();
  });

  it("leaves a short tap available to open the thread", () => {
    using gesture = setup();
    vi.advanceTimersByTime(100);
    gesture.document.dispatchEvent(pointer("pointerup"));
    const click = new Event("click", { cancelable: true });
    gesture.document.dispatchEvent(click);
    vi.runAllTimers();
    expect(gesture.onHold).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(false);
  });

  it.each([
    pointer("pointermove", { clientY: 85 }),
    pointer("pointercancel"),
    pointer("pointerdown", { pointerId: 2 }),
    new Event("scroll"),
    new Event("visibilitychange"),
  ])("cancels the hold on $type without blocking scrolling", (event) => {
    using gesture = setup();
    gesture.document.dispatchEvent(event);
    vi.runAllTimers();
    expect(gesture.onHold).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("cancels the hold when the window loses focus", () => {
    using gesture = setup();
    gesture.document.defaultView.dispatchEvent(new Event("blur"));
    vi.runAllTimers();
    expect(gesture.onHold).not.toHaveBeenCalled();
  });

  it("ignores releases and movement from a different pointer", () => {
    using gesture = setup();
    gesture.document.dispatchEvent(pointer("pointerup", { pointerId: 2 }));
    gesture.document.dispatchEvent(pointer("pointermove", { pointerId: 2, clientY: 100 }));
    vi.advanceTimersByTime(500);
    expect(gesture.onHold).toHaveBeenCalledOnce();
  });

  it("suppresses the release click after a hold and allows the next menu tap", () => {
    using gesture = setup();
    vi.advanceTimersByTime(500);
    gesture.document.dispatchEvent(pointer("pointerup"));
    const releaseClick = new Event("click", { cancelable: true });
    gesture.document.dispatchEvent(releaseClick);
    expect(releaseClick.defaultPrevented).toBe(true);

    gesture.document.dispatchEvent(pointer("pointerdown"));
    const menuClick = new Event("click", { cancelable: true });
    gesture.document.dispatchEvent(menuClick);
    expect(menuClick.defaultPrevented).toBe(false);
  });

  it("allows the next tap when the browser sends no release click", () => {
    using gesture = setup();
    vi.advanceTimersByTime(500);
    gesture.document.dispatchEvent(pointer("pointercancel"));
    gesture.document.dispatchEvent(pointer("pointerdown"));
    const menuClick = new Event("click", { cancelable: true });
    gesture.document.dispatchEvent(menuClick);
    expect(menuClick.defaultPrevented).toBe(false);
  });

  it("suppresses the native touch menu so it cannot reopen the thread menu", () => {
    using gesture = setup();
    const nativeMenu = new Event("contextmenu", { cancelable: true });
    gesture.document.dispatchEvent(nativeMenu);
    expect(nativeMenu.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(500);
    expect(gesture.onHold).toHaveBeenCalledOnce();
  });

  it("disposes the timer and listeners when the row unmounts", () => {
    using gesture = setup();
    gesture.dispose();
    vi.runAllTimers();
    const nativeMenu = new Event("contextmenu", { cancelable: true });
    gesture.document.dispatchEvent(nativeMenu);
    expect(gesture.onHold).not.toHaveBeenCalled();
    expect(nativeMenu.defaultPrevented).toBe(false);
  });
});

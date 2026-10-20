import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import type { KeyboardEventData } from "react-native-keyboard-controller";

const native = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: KeyboardEventData) => void>>(),
  dismiss: vi.fn(),
}));

// Metro uses the source entry. Exercise its real cache and hook with native
// events and commands replaced so the regression runs without a device.
vi.mock("../../../node_modules/react-native-keyboard-controller/src/bindings", () => ({
  KeyboardEvents: {
    addListener: (name: string, listener: (event: KeyboardEventData) => void) => {
      const listeners = native.listeners.get(name) ?? new Set();
      listeners.add(listener);
      native.listeners.set(name, listeners);
      return { remove: () => listeners.delete(listener) };
    },
  },
  KeyboardControllerNative: {
    setDefaultMode: vi.fn(),
    setInputMode: vi.fn(),
    setFocusTo: vi.fn(),
    preload: vi.fn(),
    setTranslucent: vi.fn(),
    dismiss: native.dismiss,
  },
}));

import { KeyboardController } from "../../../node_modules/react-native-keyboard-controller/src/module";
import { useKeyboardState } from "../../../node_modules/react-native-keyboard-controller/src/hooks/useKeyboardState";

function emit(name: string, height: number) {
  const event: KeyboardEventData = {
    height,
    duration: 0,
    timestamp: 1,
    target: 42,
    type: "default",
    appearance: "light",
  };
  act(() => {
    for (const listener of native.listeners.get(name) ?? []) listener(event);
  });
}

function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.dismiss.mockReset();
  emit("keyboardDidHide", 0);
  const container = document.createElement("div");
  const root = createRoot(container);

  function KeyboardState() {
    const state = useKeyboardState();
    return <output>{JSON.stringify({ visible: state.isVisible, height: state.height })}</output>;
  }

  act(() => root.render(<KeyboardState />));

  return {
    container,
    [Symbol.dispose]() {
      act(() => root.unmount());
      container.remove();
      emit("keyboardDidHide", 0);
      vi.unstubAllGlobals();
    },
  };
}

describe("keyboard-controller nonanimated inset recovery", () => {
  it("updates the imperative cache and mounted hook after didShow without willShow", () => {
    using screen = setup();
    expect(screen.container.textContent).toBe('{"visible":false,"height":0}');

    // Android syncKeyboardPosition can restore IME insets without willShow.
    emit("keyboardDidShow", 376);

    expect({
      visible: KeyboardController.isVisible(),
      height: KeyboardController.state().height,
      mounted: screen.container.textContent,
    }).toEqual({ visible: true, height: 376, mounted: '{"visible":true,"height":376}' });
  });

  it("waits for native dismissal after a didShow-only recovery", async () => {
    using screen = setup();
    emit("keyboardDidShow", 376);
    let settled = false;
    const dismissal = KeyboardController.dismiss().then(() => {
      settled = true;
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(native.dismiss).toHaveBeenCalledWith(false, true);
    const settledBeforeHide = settled;
    emit("keyboardDidHide", 0);
    await dismissal;

    expect(settledBeforeHide).toBe(false);
    expect(settled).toBe(true);
    expect(KeyboardController.isVisible()).toBe(false);
    expect(screen.container.textContent).toBe('{"visible":false,"height":0}');
  });

  it("still publishes willShow immediately and accepts the completed keyboard height", () => {
    using screen = setup();
    emit("keyboardWillShow", 320);
    expect(KeyboardController.isVisible()).toBe(true);
    expect(screen.container.textContent).toBe('{"visible":true,"height":320}');

    emit("keyboardDidShow", 376);
    expect(KeyboardController.state().height).toBe(376);
    expect(screen.container.textContent).toBe('{"visible":true,"height":376}');

    emit("keyboardDidHide", 0);
    expect(KeyboardController.isVisible()).toBe(false);
    expect(screen.container.textContent).toBe('{"visible":false,"height":0}');
  });
});

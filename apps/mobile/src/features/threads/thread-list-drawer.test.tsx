import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  timingTargets: [] as number[],
  pans: [] as { onFinalize?: (event: unknown, success: boolean) => void }[],
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    readonly children?: ReactNode;
    readonly onPress?: () => void;
    readonly accessibilityLabel?: string;
  }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
  StyleSheet: { create: <T,>(styles: T) => styles },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));

vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  return {
    default: {
      View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
    },
    Easing: { out: vi.fn(), cubic: vi.fn() },
    ReduceMotion: { System: "system" },
    runOnJS: (callback: () => void) => callback,
    useAnimatedStyle: () => ({}),
    useSharedValue: <T,>(initial: T) =>
      useRef({
        value: initial,
        set(value: T) {
          this.value = value;
        },
      }).current,
    withTiming: (target: number) => {
      harness.timingTargets.push(target);
      return target;
    },
  };
});

vi.mock("react-native-gesture-handler", () => {
  const pan = () => {
    const handlers: { onFinalize?: (event: unknown, success: boolean) => void } = {};
    harness.pans.push(handlers);
    const builder = {
      enabled: () => builder,
      activeOffsetX: () => builder,
      failOffsetX: () => builder,
      failOffsetY: () => builder,
      onUpdate: () => builder,
      onEnd: () => builder,
      onFinalize: (handler: (event: unknown, success: boolean) => void) => {
        handlers.onFinalize = handler;
        return builder;
      },
    };
    return builder;
  };
  return {
    Gesture: { Pan: pan, Race: () => ({}) },
    GestureDetector: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
  };
});

vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: () => Promise.resolve() },
}));

vi.mock("../../lib/backHandler", () => ({ useHardwareBack: () => undefined }));

vi.mock("../layout/adaptive-workspace-context", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false, listPaneWidth: null },
    composerKeyboardActive: false,
  }),
}));

import {
  ThreadListDrawerHost,
  ThreadListDrawerProvider,
  useThreadDetailsDrawer,
  type ThreadListDrawerContextValue,
} from "./thread-list-drawer";

function Capture({
  onChange,
}: {
  readonly onChange: (drawer: ThreadListDrawerContextValue) => void;
}) {
  const drawer = useThreadDetailsDrawer();
  useEffect(() => {
    onChange(drawer);
  }, [drawer, onChange]);
  return null;
}

function setup() {
  harness.timingTargets = [];
  harness.pans = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  let latest: ThreadListDrawerContextValue | null = null;
  act(() =>
    root.render(
      <ThreadListDrawerProvider>
        <Capture
          onChange={(drawer) => {
            latest = drawer;
          }}
        />
        <button
          type="button"
          onClick={() => {
            latest?.openDrawer();
          }}
        >
          Open
        </button>
        <ThreadListDrawerHost side="right" width={300}>
          {(drawer) => (
            <button type="button" onClick={drawer.closeDrawer}>
              Thread
            </button>
          )}
        </ThreadListDrawerHost>
      </ThreadListDrawerProvider>,
    ),
  );
  const find = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    ) as HTMLButtonElement;
  return {
    open: () => find("Open").click(),
    thread: () => find("Thread"),
    drawer: () => latest!,
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

describe("thread list drawer", () => {
  it("stays closed when a row tap closes it before the panel pan settles", () => {
    using screen = setup();
    act(() => screen.open());
    expect(screen.drawer().open).toBe(true);

    // The panel's pan finalizes on every tap. A row tap queues the close first, so
    // the settle must follow the close rather than re-target the previous open.
    act(() => {
      screen.thread().click();
      harness.pans.at(-1)?.onFinalize?.({}, false);
    });

    expect(screen.drawer().open).toBe(false);
    expect(harness.timingTargets.at(-1)).toBe(0);
  });
});

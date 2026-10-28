import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

interface PanEvent {
  readonly translationX: number;
  readonly velocityX: number;
}
interface PanHandlers {
  enabled?: boolean;
  onStart?: () => void;
  onUpdate?: (event: PanEvent) => void;
  onEnd?: (event: PanEvent) => void;
  onFinalize?: (event: unknown, success: boolean) => void;
}

const harness = vi.hoisted(() => ({
  timingTargets: [] as number[],
  pans: [] as PanHandlers[],
  split: false,
  keyboard: false,
  dismissKeyboard: vi.fn(() => Promise.resolve()),
  back: undefined as (() => boolean) | undefined,
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
    const handlers: PanHandlers = {};
    harness.pans.push(handlers);
    const builder = {
      enabled: (enabled: boolean) => {
        handlers.enabled = enabled;
        return builder;
      },
      activeOffsetX: () => builder,
      failOffsetX: () => builder,
      failOffsetY: () => builder,
      onStart: (handler: () => void) => {
        handlers.onStart = handler;
        return builder;
      },
      onUpdate: (handler: (event: PanEvent) => void) => {
        handlers.onUpdate = handler;
        return builder;
      },
      onEnd: (handler: (event: PanEvent) => void) => {
        handlers.onEnd = handler;
        return builder;
      },
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
  KeyboardController: { dismiss: harness.dismissKeyboard },
}));

vi.mock("../../lib/backHandler", () => ({
  useHardwareBack: (enabled: boolean, handleBack: () => boolean) => {
    if (enabled) harness.back = handleBack;
  },
}));

vi.mock("../layout/adaptive-workspace-context", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: harness.split, listPaneWidth: null },
    composerKeyboardActive: harness.keyboard,
  }),
}));

import {
  ThreadListDrawerHost,
  ThreadListDrawerProvider,
  ThreadListDrawerGestureWrapper,
  useThreadListDrawer,
  useThreadDetailsDrawer,
  threadListDrawerWidth,
  type ThreadListDrawerContextValue,
} from "./thread-list-drawer";

function Capture({
  onChange,
}: {
  readonly onChange: (drawers: {
    left: ThreadListDrawerContextValue;
    right: ThreadListDrawerContextValue;
  }) => void;
}) {
  const left = useThreadListDrawer();
  const right = useThreadDetailsDrawer();
  useEffect(() => {
    onChange({ left, right });
  }, [left, right, onChange]);
  return null;
}

function setup() {
  harness.timingTargets = [];
  harness.pans = [];
  harness.split = false;
  harness.keyboard = false;
  harness.back = undefined;
  harness.dismissKeyboard.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  let latest: {
    left: ThreadListDrawerContextValue;
    right: ThreadListDrawerContextValue;
  };
  const render = () =>
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
            latest.right.openDrawer();
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
        <ThreadListDrawerGestureWrapper detailsEnabled>
          <span>Feed</span>
        </ThreadListDrawerGestureWrapper>
      </ThreadListDrawerProvider>,
    );
  act(render);
  const find = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    ) as HTMLButtonElement;
  return {
    open: () => find("Open").click(),
    thread: () => find("Thread"),
    drawer: () => latest.right,
    drawers: () => latest,
    render,
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

describe("thread list drawer", () => {
  it("mounts details on first opening and switches sides exclusively", () => {
    using screen = setup();
    expect(screen.thread()).toBeUndefined();

    act(() => screen.drawers().left.openDrawer());
    expect(screen.drawers().left.open).toBe(true);
    expect(screen.drawers().right.open).toBe(false);
    expect(harness.dismissKeyboard).toHaveBeenCalledOnce();

    act(() => screen.drawers().right.openDrawer());
    expect(screen.drawers().left.open).toBe(false);
    expect(screen.drawers().right.open).toBe(true);
    expect(screen.thread()).toBeDefined();
    expect(harness.timingTargets.slice(-2)).toEqual([0, 1]);

    act(() => screen.drawers().left.closeDrawer());
    expect(screen.drawers().right.open).toBe(true);
    act(() => screen.drawers().right.closeDrawer());
    expect(screen.drawers().right.open).toBe(false);
    expect(screen.thread()).toBeDefined();
  });

  it("opens, cancels and closes details by dragging", () => {
    using screen = setup();
    const opening = harness.pans.findLast((pan) => pan.enabled)!;
    act(() => opening.onStart?.());
    act(() => opening.onUpdate?.({ translationX: -137.6, velocityX: 0 }));
    expect(screen.drawer().progress.value).toBeCloseTo(0.4);
    act(() => opening.onFinalize?.({}, false));
    expect(screen.drawer().open).toBe(false);
    expect(screen.drawer().progress.value).toBe(0);

    act(() => {
      opening.onStart?.();
      opening.onEnd?.({ translationX: -137.6, velocityX: 0 });
    });
    expect(screen.drawer().open).toBe(true);
    const closing = harness.pans.findLast((pan) => pan.enabled)!;
    act(() => closing.onUpdate?.({ translationX: 120, velocityX: 0 }));
    expect(screen.drawer().progress.value).toBeCloseTo(0.6);
    act(() => closing.onFinalize?.({}, false));
    expect(screen.drawer().progress.value).toBe(1);
    act(() => closing.onEnd?.({ translationX: 20, velocityX: 600 }));
    expect(screen.drawer().open).toBe(false);
  });

  it("does not restart the other side's animation when an opening pan is cancelled", () => {
    using screen = setup();
    const opening = harness.pans.findLast((pan) => pan.enabled)!;
    act(() => opening.onStart?.());
    act(() => screen.drawers().left.openDrawer());
    const animationsBeforeCancel = harness.timingTargets.length;
    act(() => opening.onFinalize?.({}, false));
    expect(screen.drawers().left.open).toBe(true);
    expect(screen.drawers().right.open).toBe(false);
    expect(harness.timingTargets.slice(animationsBeforeCancel)).toEqual([0]);
  });

  it("disables feed opening gestures while the composer owns the keyboard", () => {
    using screen = setup();
    expect(harness.pans.at(-1)?.enabled).toBe(true);
    harness.keyboard = true;
    act(screen.render);
    expect(harness.pans.at(-1)?.enabled).toBe(false);
  });

  it("keeps the drawer within the pane and the compact viewport", () => {
    expect(threadListDrawerWidth(null, 1000)).toBe(360);
    expect(threadListDrawerWidth(300, 1000)).toBe(300);
    expect(threadListDrawerWidth(400, 400)).toBe(344);
  });

  it("closes on hardware back and yields to split view on rotation", () => {
    using screen = setup();
    act(() => screen.open());
    act(() => expect(harness.back?.()).toBe(true));
    expect(screen.drawer().open).toBe(false);
    expect(harness.back?.()).toBe(false);
    act(() => screen.open());
    harness.split = true;
    act(screen.render);
    expect(screen.drawer().open).toBe(false);
    expect(harness.timingTargets.slice(-2)).toEqual([0, 0]);
    expect(screen.thread()).toBeUndefined();
  });

  it("stays closed when a row tap closes it before the panel pan settles", () => {
    using screen = setup();
    act(() => screen.open());
    expect(screen.drawer().open).toBe(true);

    // The panel's pan finalizes on every tap. A row tap queues the close first, so
    // the settle must follow the close rather than re-target the previous open.
    act(() => {
      screen.thread().click();
      harness.pans.findLast((pan) => pan.enabled)?.onFinalize?.({}, false);
    });

    expect(screen.drawer().open).toBe(false);
    expect(harness.timingTargets.at(-1)).toBe(0);
  });
});

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { describe, expect, it, vi } from "vite-plus/test";

type SwipeableProps = ComponentProps<typeof ReanimatedSwipeable>;
const harness = vi.hoisted(() => ({ timingTargets: [] as number[] }));

vi.mock("../layout/adaptive-workspace-context", () => ({}));
vi.mock("expo-haptics", () => ({}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  return {
    default: {
      View: ({ children, ref }: { children: ReactNode; ref?: React.Ref<HTMLDivElement> }) => (
        <div ref={ref}>{children}</div>
      ),
    },
    Easing: { out: vi.fn(), cubic: vi.fn() },
    ReduceMotion: { System: "system" },
    Extrapolation: { CLAMP: "clamp" },
    interpolate: vi.fn(),
    cancelAnimation: vi.fn(),
    runOnJS: (callback: unknown) => callback,
    runOnUI: (callback: unknown) => callback,
    useAnimatedReaction: vi.fn(),
    useAnimatedStyle: () => ({}),
    useSharedValue: <T,>(initial: T) =>
      useRef({
        value: initial,
        set(value: T) {
          this.value = value;
        },
      }).current,
    withTiming: (target: number, _options: unknown, finished?: (completed: boolean) => void) => {
      harness.timingTargets.push(target);
      finished?.(true);
      return target;
    },
  };
});
vi.mock("react-native-gesture-handler/ReanimatedSwipeable", async () => {
  const { useImperativeHandle, useMemo, useRef } = await import("react");
  const { useSharedValue } = await import("react-native-reanimated");
  return {
    default: function NativeSwipeable(props: SwipeableProps) {
      const translation = useSharedValue(0);
      const progress = useSharedValue(0);
      const panActive = useRef(false);
      const methods = useMemo(
        () => ({ close: vi.fn(), openLeft: vi.fn(), openRight: vi.fn(), reset: vi.fn() }),
        [],
      );
      useImperativeHandle(props.ref, () => methods, [methods]);
      return (
        <div
          onPointerDownCapture={() => {
            panActive.current = false;
          }}
          onPointerMoveCapture={(event) => {
            // RNGH uses these signed offsets as the inactive range around the touch origin.
            const fromRight = props.dragOffsetFromRight ?? -10;
            const fromLeft = props.dragOffsetFromLeft ?? 10;
            const start = typeof fromRight === "number" ? fromRight : fromRight.value;
            const end = typeof fromLeft === "number" ? fromLeft : fromLeft.value;
            panActive.current =
              props.enabled !== false && (event.clientX < start || event.clientX > end);
            translation.set(event.clientX);
          }}
          onPointerUpCapture={() => {
            if (panActive.current) props.onSwipeableRelease?.(translation);
          }}
          onClickCapture={(event) => {
            if (panActive.current) event.stopPropagation();
          }}
        >
          {props.renderLeftActions?.(progress, translation, methods)}
          {props.renderRightActions?.(progress, translation, methods)}
          {props.children}
        </div>
      );
    },
  };
});

import { withThreadDismissal } from "./thread-dismissal";
import { ThreadSwipeable } from "./thread-swipe-actions";

function setup(side: "left" | "right", onPrimary: () => void = vi.fn()) {
  harness.timingTargets = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <ThreadSwipeable
        backgroundColor="white"
        fullSwipeAction="primary"
        fullSwipeWidth={400}
        onDelete={vi.fn()}
        primaryAction={{
          accessibilityLabel: "Settle thread",
          icon: "checkmark",
          label: "Settle",
          onPress: onPrimary,
        }}
        side={side}
        threadKey="env:thread"
        threadTitle="Thread"
      >
        {() => (
          <button type="button" onClick={onPrimary}>
            Open thread
          </button>
        )}
      </ThreadSwipeable>,
    ),
  );
  const thread = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Open thread",
  )!;
  return {
    thread,
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}

function pointer(target: HTMLElement, type: string, translationX: number) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: translationX }));
}

describe("thread swipe input", () => {
  it.each(["left", "right"] as const)(
    "keeps thread taps with small finger drift tappable with %s actions",
    (side) => {
      const selectThread = vi.fn();
      using row = setup(side, selectThread);
      for (const drift of [-1, 0, 1]) {
        act(() => {
          pointer(row.thread, "pointerdown", 0);
          pointer(row.thread, "pointermove", drift);
          row.thread.click();
        });
      }
      expect(selectThread).toHaveBeenCalledTimes(3);

      act(() => {
        pointer(row.thread, "pointerdown", 0);
        pointer(row.thread, "pointermove", side === "left" ? 20 : -20);
        row.thread.click();
      });
      expect(selectThread).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    { side: "left", release: 300, target: 400 },
    { side: "right", release: -300, target: -400 },
    { side: "left", release: 520, target: 520 },
    { side: "right", release: -520, target: -520 },
  ] as const)("finishes a $side full swipe from $release at $target", async (test) => {
    const settle = vi.fn(async () => true);
    using row = setup(test.side, () => {
      void withThreadDismissal("env:thread", settle, Boolean);
    });
    await act(async () => {
      pointer(row.thread, "pointerdown", 0);
      pointer(row.thread, "pointermove", test.release);
      pointer(row.thread, "pointerup", test.release);
    });
    expect(settle).toHaveBeenCalledOnce();
    expect(harness.timingTargets).toContain(test.target);
    expect(harness.timingTargets).not.toContain(-test.target);
  });
});

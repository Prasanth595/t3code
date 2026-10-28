import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardController } from "react-native-keyboard-controller";
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { useHardwareBack } from "../../lib/backHandler";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import {
  drawerDragProgress,
  drawerShouldOpen,
  type ThreadDrawerSide,
} from "./thread-drawer-gesture";

const DRAWER_MAX_WIDTH = 360;
const DRAWER_WIDTH_RATIO = 0.86;
// Activate before the feed's long-press selection; vertical scrolling still wins.
const DRAWER_ACTIVATION_DISTANCE = 12;
const DRAWER_VERTICAL_FAIL_DISTANCE = 18;
const DRAWER_TIMING = {
  duration: 260,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;

export function threadListDrawerWidth(listPaneWidth: number | null, viewportWidth: number): number {
  return Math.min(listPaneWidth ?? DRAWER_MAX_WIDTH, viewportWidth * DRAWER_WIDTH_RATIO);
}

export interface ThreadListDrawerState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly openDrawer: () => void;
  readonly closeDrawer: () => void;
  readonly toggleDrawer: () => void;
}

export interface ThreadListDrawerContextValue extends ThreadListDrawerState {
  readonly progress: SharedValue<number>;
  readonly mounted: boolean;
  readonly prepareOpen: () => void;
}

export const ThreadListDrawerContext = createContext<ThreadListDrawerContextValue | null>(null);
const ThreadDetailsDrawerContext = createContext<ThreadListDrawerContextValue | null>(null);

export function useThreadListDrawer(): ThreadListDrawerContextValue {
  const drawer = useContext(ThreadListDrawerContext);
  if (drawer === null) {
    throw new Error("useThreadListDrawer must be used inside a ThreadListDrawerProvider");
  }
  return drawer;
}

export function useThreadDetailsDrawer(): ThreadListDrawerContextValue {
  const drawer = useContext(ThreadDetailsDrawerContext);
  if (drawer === null) {
    throw new Error("useThreadDetailsDrawer must be used inside a ThreadListDrawerProvider");
  }
  return drawer;
}

function useDrawerState(
  side: ThreadDrawerSide,
  active: ThreadDrawerSide | null,
  setActive: (side: ThreadDrawerSide, open: boolean) => void,
  progress: SharedValue<number>,
) {
  const open = active === side;
  const [mounted, setMounted] = useState(false);
  const prepareOpen = useCallback(() => setMounted(true), []);
  const setOpen = useCallback((next: boolean) => setActive(side, next), [setActive, side]);
  const openDrawer = useCallback(() => {
    void KeyboardController.dismiss();
    prepareOpen();
    setOpen(true);
  }, [prepareOpen, setOpen]);
  const closeDrawer = useCallback(() => setOpen(false), [setOpen]);
  const toggleDrawer = useCallback(() => {
    if (open) closeDrawer();
    else openDrawer();
  }, [open, closeDrawer, openDrawer]);
  return useMemo<ThreadListDrawerContextValue>(
    () => ({
      open,
      setOpen,
      openDrawer,
      closeDrawer,
      toggleDrawer,
      progress,
      mounted,
      prepareOpen,
    }),
    [open, setOpen, openDrawer, closeDrawer, toggleDrawer, progress, mounted, prepareOpen],
  );
}

export function ThreadListDrawerProvider({ children }: { readonly children: ReactNode }) {
  const [active, setActiveState] = useState<ThreadDrawerSide | null>(null);
  const activeRef = useRef<ThreadDrawerSide | null>(null);
  const leftProgress = useSharedValue(0);
  const rightProgress = useSharedValue(0);
  const setActive = useCallback(
    (side: ThreadDrawerSide, open: boolean) => {
      const next = open ? side : activeRef.current === side ? null : activeRef.current;
      if (!open && activeRef.current === side) void KeyboardController.dismiss();
      activeRef.current = next;
      setActiveState(next);
      leftProgress.set(withTiming(next === "left" ? 1 : 0, DRAWER_TIMING));
      rightProgress.set(withTiming(next === "right" ? 1 : 0, DRAWER_TIMING));
    },
    [leftProgress, rightProgress],
  );
  const left = useDrawerState("left", active, setActive, leftProgress);
  const right = useDrawerState("right", active, setActive, rightProgress);
  return (
    <ThreadListDrawerContext value={left}>
      <ThreadDetailsDrawerContext value={right}>{children}</ThreadDetailsDrawerContext>
    </ThreadListDrawerContext>
  );
}

interface ThreadListDrawerHostProps {
  readonly width: number;
  readonly side?: ThreadDrawerSide;
  readonly children: (drawer: ThreadListDrawerState) => ReactNode;
}

export function ThreadListDrawerHost({
  width,
  side = "left",
  children,
}: ThreadListDrawerHostProps) {
  const drawer = useContext(side === "left" ? ThreadListDrawerContext : ThreadDetailsDrawerContext);
  const { layout } = useAdaptiveWorkspaceLayout();
  const enabled =
    (side === "right" || Platform.OS === "android") && !layout.usesSplitView && drawer !== null;
  const isOpen = drawer?.open ?? false;
  const open = enabled && isOpen;
  const fallbackProgress = useSharedValue(0);
  const progress = drawer?.progress ?? fallbackProgress;
  const setOpen = drawer?.setOpen;
  const closeDrawer = drawer?.closeDrawer;

  // oxlint-disable-next-line t3code/react-effect-budget -- rotation must close the phone overlay before split view takes ownership
  useEffect(() => {
    if (!enabled && isOpen && setOpen) setOpen(false);
  }, [enabled, isOpen, setOpen]);

  const commitOpen = useEffectEvent((next: boolean) => setOpen?.(next));
  const settleOpen = useEffectEvent(() => {
    progress.set(withTiming(drawer?.open ? 1 : 0, DRAWER_TIMING));
  });
  const handleBack = useEffectEvent(() => {
    if (!drawer?.open) return false;
    closeDrawer?.();
    return true;
  });
  useHardwareBack(enabled && isOpen, handleBack);

  const closeGesture = useMemo(
    () =>
      // oxlint-disable-next-line react/capitalized-calls -- Gesture.Pan is a gesture factory, not a React component.
      Gesture.Pan()
        .enabled(open && width > 0)
        .activeOffsetX(side === "left" ? -DRAWER_ACTIVATION_DISTANCE : DRAWER_ACTIVATION_DISTANCE)
        .failOffsetY([-DRAWER_VERTICAL_FAIL_DISTANCE, DRAWER_VERTICAL_FAIL_DISTANCE])
        .onUpdate((event) => {
          "worklet";
          progress.set(drawerDragProgress(side, event.translationX, width, true));
        })
        .onEnd((event) => {
          "worklet";
          runOnJS(commitOpen)(
            drawerShouldOpen(side, event.translationX, event.velocityX, width, true),
          );
        })
        .onFinalize((_event, success) => {
          "worklet";
          if (!success) runOnJS(settleOpen)();
        }),
    // oxlint-disable-next-line react/memo-dependencies -- runOnJS needs the effect event in its dependency set.
    [open, width, side, progress, commitOpen, settleOpen],
  );

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (side === "left" ? -1 : 1) * width * (1 - progress.value) }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  if (!enabled || drawer === null) return null;

  return (
    <View
      className="absolute inset-0"
      pointerEvents={open ? "auto" : "none"}
      style={styles.overlay}
    >
      <Animated.View style={[styles.scrim, scrimStyle]}>
        <Pressable
          className="flex-1"
          accessibilityRole="button"
          accessibilityLabel={side === "left" ? "Close threads" : "Close thread details"}
          onPress={closeDrawer}
        />
      </Animated.View>
      <GestureDetector gesture={closeGesture}>
        <Animated.View
          className={
            side === "left"
              ? "absolute bottom-0 left-0 top-0 overflow-hidden bg-header"
              : "absolute bottom-0 right-0 top-0 overflow-hidden bg-header"
          }
          accessibilityViewIsModal={open}
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? "auto" : "no-hide-descendants"}
          style={[styles.panel, { width }, panelStyle]}
        >
          {side === "left" || drawer.mounted ? children(drawer) : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function useDrawerOpenGesture(
  side: ThreadDrawerSide,
  drawer: ThreadListDrawerContextValue | null,
  enabled: boolean,
  width: number,
) {
  const fallbackProgress = useSharedValue(0);
  const progress = drawer?.progress ?? fallbackProgress;
  const commitOpen = useEffectEvent((next: boolean) => drawer?.setOpen(next));
  const prepareOpen = useEffectEvent(() => drawer?.prepareOpen());
  const settleOpen = useEffectEvent(() => {
    progress.set(withTiming(drawer?.open ? 1 : 0, DRAWER_TIMING));
  });
  return useMemo(
    () =>
      // oxlint-disable-next-line react/capitalized-calls -- Gesture.Pan is a gesture factory, not a React component.
      Gesture.Pan()
        .enabled(enabled && width > 0)
        .activeOffsetX(side === "left" ? DRAWER_ACTIVATION_DISTANCE : -DRAWER_ACTIVATION_DISTANCE)
        .failOffsetX(side === "left" ? -DRAWER_ACTIVATION_DISTANCE : DRAWER_ACTIVATION_DISTANCE)
        .failOffsetY([-DRAWER_VERTICAL_FAIL_DISTANCE, DRAWER_VERTICAL_FAIL_DISTANCE])
        .onStart(() => {
          "worklet";
          runOnJS(prepareOpen)();
        })
        .onUpdate((event) => {
          "worklet";
          progress.set(drawerDragProgress(side, event.translationX, width, false));
        })
        .onEnd((event) => {
          "worklet";
          runOnJS(commitOpen)(
            drawerShouldOpen(side, event.translationX, event.velocityX, width, false),
          );
        })
        .onFinalize((_event, success) => {
          "worklet";
          if (!success) runOnJS(settleOpen)();
        }),
    // oxlint-disable-next-line react/memo-dependencies -- runOnJS needs the effect events in its dependency set.
    [enabled, width, side, progress, commitOpen, prepareOpen, settleOpen],
  );
}

export function ThreadListDrawerGestureWrapper({
  children,
  detailsEnabled,
}: {
  readonly children: ReactNode;
  readonly detailsEnabled: boolean;
}) {
  const threads = useContext(ThreadListDrawerContext);
  const details = useContext(ThreadDetailsDrawerContext);
  const { layout, composerKeyboardActive } = useAdaptiveWorkspaceLayout();
  const { width: viewportWidth } = useWindowDimensions();
  const width = threadListDrawerWidth(layout.listPaneWidth, viewportWidth);
  const enabled =
    !layout.usesSplitView && !composerKeyboardActive && !threads?.open && !details?.open;
  const left = useDrawerOpenGesture("left", threads, enabled && Platform.OS === "android", width);
  const right = useDrawerOpenGesture("right", details, enabled && detailsEnabled, width);
  // oxlint-disable-next-line react/capitalized-calls -- Gesture.Race composes native gestures, not React components.
  const gesture = useMemo(() => Gesture.Race(left, right), [left, right]);
  return (
    <GestureDetector gesture={gesture}>
      <View className="flex-1">{children}</View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  overlay: { zIndex: 40, elevation: 12 },
  scrim: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0, 0, 0, 0.4)",
  },
  panel: { elevation: 8 },
});

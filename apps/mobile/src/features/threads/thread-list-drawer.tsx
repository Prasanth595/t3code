import {
  createContext,
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

const ThreadDrawersContext = createContext<ReturnType<typeof useDrawers> | null>(null);

function useDrawers() {
  const [active, setActive] = useState<ThreadDrawerSide | null>(null);
  const activeRef = useRef<ThreadDrawerSide | null>(null);
  const [detailsMounted, setDetailsMounted] = useState(false);
  const left = useSharedValue(0);
  const right = useSharedValue(0);
  const animateTo = (next: ThreadDrawerSide | null) => {
    left.set(withTiming(next === "left" ? 1 : 0, DRAWER_TIMING));
    right.set(withTiming(next === "right" ? 1 : 0, DRAWER_TIMING));
  };
  const setOpen = (side: ThreadDrawerSide, open: boolean) => {
    const next = open ? side : activeRef.current === side ? null : activeRef.current;
    if (!open && activeRef.current === side) void KeyboardController.dismiss();
    activeRef.current = next;
    setActive(next);
    animateTo(next);
  };
  const prepareOpen = (side: ThreadDrawerSide) => {
    if (side === "right") setDetailsMounted(true);
  };
  // A row tap can close before its pan finalizes with an older render's state.
  const settleProgress = () => animateTo(activeRef.current);
  return { active, left, right, detailsMounted, setOpen, prepareOpen, settleProgress };
}

export function ThreadListDrawerProvider({ children }: { readonly children: ReactNode }) {
  const drawers = useDrawers();
  return <ThreadDrawersContext value={drawers}>{children}</ThreadDrawersContext>;
}

function useThreadDrawer(side: ThreadDrawerSide) {
  const drawers = useContext(ThreadDrawersContext);
  if (drawers === null) {
    throw new Error("Thread drawers must be used inside a ThreadListDrawerProvider");
  }
  const setOpen = (open: boolean) => drawers.setOpen(side, open);
  const prepareOpen = () => drawers.prepareOpen(side);
  const openDrawer = () => {
    void KeyboardController.dismiss();
    prepareOpen();
    setOpen(true);
  };
  const closeDrawer = () => setOpen(false);
  return {
    open: drawers.active === side,
    progress: drawers[side],
    mounted: side === "left" || drawers.detailsMounted,
    setOpen,
    prepareOpen,
    openDrawer,
    closeDrawer,
    settleProgress: drawers.settleProgress,
  };
}

export type ThreadListDrawerContextValue = ReturnType<typeof useThreadDrawer>;

export function useThreadListDrawer() {
  return useThreadDrawer("left");
}

export function useThreadDetailsDrawer() {
  return useThreadDrawer("right");
}

function useDrawerGesture(
  side: ThreadDrawerSide,
  drawer: ThreadListDrawerContextValue,
  enabled: boolean,
  width: number,
  open: boolean,
) {
  const { progress } = drawer;
  const commitOpen = useEffectEvent((next: boolean) => drawer.setOpen(next));
  const prepareOpen = useEffectEvent(() => drawer.prepareOpen());
  const settleOpen = useEffectEvent(() => {
    if (open) drawer.settleProgress();
    else progress.set(withTiming(drawer.open ? 1 : 0, DRAWER_TIMING));
  });
  return useMemo(() => {
    const direction = (side === "left" ? 1 : -1) * (open ? -1 : 1);
    // oxlint-disable-next-line react/capitalized-calls -- Gesture.Pan is a gesture factory, not a React component.
    const gesture = Gesture.Pan()
      .enabled(enabled && width > 0)
      .activeOffsetX(direction * DRAWER_ACTIVATION_DISTANCE)
      .failOffsetY([-DRAWER_VERTICAL_FAIL_DISTANCE, DRAWER_VERTICAL_FAIL_DISTANCE])
      .onStart(() => {
        "worklet";
        if (!open) runOnJS(prepareOpen)();
      })
      .onUpdate((event) => {
        "worklet";
        progress.set(drawerDragProgress(side, event.translationX, width, open));
      })
      .onEnd((event) => {
        "worklet";
        runOnJS(commitOpen)(
          drawerShouldOpen(side, event.translationX, event.velocityX, width, open),
        );
      })
      .onFinalize((_event, success) => {
        "worklet";
        if (!success) runOnJS(settleOpen)();
      });
    if (!open) gesture.failOffsetX(-direction * DRAWER_ACTIVATION_DISTANCE);
    return gesture;
    // oxlint-disable-next-line react/memo-dependencies -- runOnJS needs the effect events in its dependency set.
  }, [enabled, width, open, side, progress, commitOpen, prepareOpen, settleOpen]);
}

export function ThreadListDrawerHost({
  width,
  side = "left",
  children,
}: {
  readonly width: number;
  readonly side?: ThreadDrawerSide;
  readonly children: (drawer: ThreadListDrawerContextValue) => ReactNode;
}) {
  const drawer = useThreadDrawer(side);
  const { layout } = useAdaptiveWorkspaceLayout();
  const enabled = (side === "right" || Platform.OS === "android") && !layout.usesSplitView;
  const { open: isOpen, setOpen, closeDrawer, progress } = drawer;
  const open = enabled && isOpen;

  // oxlint-disable-next-line t3code/react-effect-budget -- rotation must close the phone overlay before split view takes ownership
  useEffect(() => {
    if (!enabled && isOpen) setOpen(false);
  }, [enabled, isOpen, setOpen]);

  const handleBack = useEffectEvent(() => {
    if (!drawer.open) return false;
    closeDrawer();
    return true;
  });
  useHardwareBack(open, handleBack);
  const closeGesture = useDrawerGesture(side, drawer, open, width, true);
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (side === "left" ? -1 : 1) * width * (1 - progress.value) }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  if (!enabled) return null;

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
          {drawer.mounted ? children(drawer) : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

export function ThreadListDrawerGestureWrapper({
  children,
  detailsEnabled,
}: {
  readonly children: ReactNode;
  readonly detailsEnabled: boolean;
}) {
  const threads = useThreadListDrawer();
  const details = useThreadDetailsDrawer();
  const { layout, composerKeyboardActive } = useAdaptiveWorkspaceLayout();
  const { width: viewportWidth } = useWindowDimensions();
  const width = threadListDrawerWidth(layout.listPaneWidth, viewportWidth);
  const enabled =
    !layout.usesSplitView && !composerKeyboardActive && !threads.open && !details.open;
  const left = useDrawerGesture(
    "left",
    threads,
    enabled && Platform.OS === "android",
    width,
    false,
  );
  const right = useDrawerGesture("right", details, enabled && detailsEnabled, width, false);
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

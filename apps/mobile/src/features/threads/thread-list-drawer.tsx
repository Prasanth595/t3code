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

/**
 * ChatGPT-style thread list drawer: the compact Android thread sidebar slides over the chat from
 * the left. Split view (tablet / unfolded) keeps its own sidebar and iOS keeps its native chrome,
 * so this file only ever draws on `Platform.OS === "android"` without a split layout.
 */

const DRAWER_MAX_WIDTH = 360;
const DRAWER_WIDTH_RATIO = 0.86;
const DRAWER_OPEN_DURATION = 260;
const DRAWER_OPEN_ACTIVATION_DISTANCE = 24;
const DRAWER_CLOSE_ACTIVATION_DISTANCE = 24;
const DRAWER_VERTICAL_FAIL_DISTANCE = 18;
const DRAWER_OPEN_COMMIT_RATIO = 0.35;
const DRAWER_CLOSE_COMMIT_RATIO = 0.35;
const DRAWER_OPEN_COMMIT_VELOCITY = 500;
const DRAWER_CLOSE_COMMIT_VELOCITY = -500;
const SCRIM_COLOR = "rgba(0, 0, 0, 0.4)";
const DRAWER_TIMING = {
  duration: DRAWER_OPEN_DURATION,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;

/** The drawer is narrower than the viewport so the chat stays visibly behind it. */
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
  /** 0 = closed, 1 = fully open. Drags write it directly; commits animate it. */
  readonly progress: SharedValue<number>;
}

export const ThreadListDrawerContext = createContext<ThreadListDrawerContextValue | null>(null);

export function useThreadListDrawer(): ThreadListDrawerContextValue {
  const drawer = useContext(ThreadListDrawerContext);
  if (drawer === null) {
    throw new Error("useThreadListDrawer must be used inside a ThreadListDrawerProvider");
  }
  return drawer;
}

export function ThreadListDrawerProvider({ children }: { readonly children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  const openRef = useRef(false);
  const progress = useSharedValue(0);

  const setOpen = useCallback(
    (next: boolean) => {
      openRef.current = next;
      setOpenState(next);
      progress.set(withTiming(next ? 1 : 0, DRAWER_TIMING));
    },
    [progress],
  );
  const openDrawer = useCallback(() => {
    // The drawer takes the screen; leaving the composer's keyboard up would keep it half covered.
    void KeyboardController.dismiss();
    setOpen(true);
  }, [setOpen]);
  const closeDrawer = useCallback(() => setOpen(false), [setOpen]);
  const toggleDrawer = useCallback(() => {
    if (openRef.current) {
      setOpen(false);
      return;
    }
    void KeyboardController.dismiss();
    setOpen(true);
  }, [setOpen]);

  const value = useMemo<ThreadListDrawerContextValue>(
    () => ({ open, setOpen, openDrawer, closeDrawer, toggleDrawer, progress }),
    [open, setOpen, openDrawer, closeDrawer, toggleDrawer, progress],
  );
  return <ThreadListDrawerContext value={value}>{children}</ThreadListDrawerContext>;
}

/** Tracks the drag in place, so the panel follows the finger instead of only snapping. */
function drawerProgress(value: number): number {
  "worklet";
  return Math.min(1, Math.max(0, value));
}

interface ThreadListDrawerHostProps {
  /** Resolved panel width; the sidebar inside is rendered at the same width. */
  readonly width: number;
  /** Rendered inside the sliding panel. Receives the drawer state it has to reflect. */
  readonly children: (drawer: ThreadListDrawerState) => ReactNode;
}

export function ThreadListDrawerHost({ width, children }: ThreadListDrawerHostProps) {
  const drawer = useContext(ThreadListDrawerContext);
  const { layout } = useAdaptiveWorkspaceLayout();
  const enabled = Platform.OS === "android" && !layout.usesSplitView && drawer !== null;
  const isOpen = drawer?.open ?? false;
  const open = enabled && isOpen;
  const fallbackProgress = useSharedValue(0);
  const progress = drawer?.progress ?? fallbackProgress;
  const setOpen = drawer?.setOpen;
  const closeDrawer = drawer?.closeDrawer;

  // A rotation into split view drops the drawer from the tree; do not leave it "open" behind.
  // oxlint-disable-next-line t3code/react-effect-budget -- a tablet rotation must not leave a phone drawer open
  useEffect(() => {
    if (!enabled && isOpen && setOpen) setOpen(false);
  }, [enabled, isOpen, setOpen]);

  const commitOpen = useEffectEvent((next: boolean) => setOpen?.(next));
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
        .activeOffsetX(-DRAWER_CLOSE_ACTIVATION_DISTANCE)
        .failOffsetY([-DRAWER_VERTICAL_FAIL_DISTANCE, DRAWER_VERTICAL_FAIL_DISTANCE])
        .onUpdate((event) => {
          "worklet";
          progress.set(drawerProgress(1 + event.translationX / width));
        })
        .onFinalize((event) => {
          "worklet";
          const shouldClose =
            event.translationX < -width * DRAWER_CLOSE_COMMIT_RATIO ||
            event.velocityX < DRAWER_CLOSE_COMMIT_VELOCITY;
          runOnJS(commitOpen)(!shouldClose);
        }),
    // oxlint-disable-next-line react/memo-dependencies -- The compiler infers the effect event, and runOnJS needs it in the dep set.
    [open, width, progress, commitOpen],
  );

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -width * (1 - progress.value) }],
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
          accessibilityLabel="Close threads"
          onPress={() => drawer.closeDrawer()}
        />
      </Animated.View>
      <GestureDetector gesture={closeGesture}>
        <Animated.View
          className="absolute bottom-0 left-0 top-0 overflow-hidden bg-header"
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? "auto" : "no-hide-descendants"}
          style={[styles.panel, { width }, panelStyle]}
        >
          {children(drawer)}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/**
 * Swipe right on the chat to pull the drawer in. The pan gives up as soon as the finger moves
 * vertically, so the feed keeps scrolling.
 */
export function ThreadListDrawerGestureWrapper({ children }: { readonly children: ReactNode }) {
  const drawer = useContext(ThreadListDrawerContext);
  const { layout, composerKeyboardActive } = useAdaptiveWorkspaceLayout();
  const { width: viewportWidth } = useWindowDimensions();
  const width = threadListDrawerWidth(layout.listPaneWidth, viewportWidth);
  const fallbackProgress = useSharedValue(0);
  const progress = drawer?.progress ?? fallbackProgress;
  const setOpen = drawer?.setOpen;
  const commitOpen = useEffectEvent((next: boolean) => setOpen?.(next));

  const canOpen =
    Platform.OS === "android" &&
    !layout.usesSplitView &&
    // Design: while a sheet owns the screen (composer keyboard up), the swipe stays inert.
    !composerKeyboardActive &&
    drawer !== null &&
    !drawer.open;

  const openGesture = useMemo(
    () =>
      // oxlint-disable-next-line react/capitalized-calls -- Gesture.Pan is a gesture factory, not a React component.
      Gesture.Pan()
        .enabled(canOpen && width > 0)
        .activeOffsetX(DRAWER_OPEN_ACTIVATION_DISTANCE)
        .failOffsetY([-DRAWER_VERTICAL_FAIL_DISTANCE, DRAWER_VERTICAL_FAIL_DISTANCE])
        .onUpdate((event) => {
          "worklet";
          progress.set(drawerProgress(event.translationX / width));
        })
        .onFinalize((event) => {
          "worklet";
          const shouldOpen =
            event.translationX > width * DRAWER_OPEN_COMMIT_RATIO ||
            event.velocityX > DRAWER_OPEN_COMMIT_VELOCITY;
          runOnJS(commitOpen)(shouldOpen);
        }),
    // oxlint-disable-next-line react/memo-dependencies -- The compiler infers the effect event, and runOnJS needs it in the dep set.
    [canOpen, width, progress, commitOpen],
  );

  return (
    <GestureDetector gesture={openGesture}>
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
    backgroundColor: SCRIM_COLOR,
  },
  panel: { elevation: 8 },
});

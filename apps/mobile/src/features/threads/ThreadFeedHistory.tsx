import {
  createContext,
  useCallback,
  useContext,
  useEffectEvent,
  useMemo,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react";
import { Pressable, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedProps,
  useAnimatedRef,
  useScrollOffset,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import type { ThreadFeedHistoryControls } from "./ThreadFeed";
import { INITIAL_THREAD_HISTORY_PULL, reduceThreadHistoryPull } from "./thread-history-pull";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const RING_CIRCUMFERENCE = 2 * Math.PI * 10;

const ThreadFeedHistoryContext = createContext<{
  readonly controls: ThreadFeedHistoryControls | undefined;
  readonly topInset: number;
  readonly pull: SharedValue<typeof INITIAL_THREAD_HISTORY_PULL>;
} | null>(null);

export function ThreadFeedHistoryProvider(props: {
  readonly controls: ThreadFeedHistoryControls | undefined;
  readonly topInset: number;
  readonly children: ReactNode;
}) {
  const pull = useSharedValue(INITIAL_THREAD_HISTORY_PULL);
  return (
    <ThreadFeedHistoryContext value={{ controls: props.controls, topInset: props.topInset, pull }}>
      {props.children}
    </ThreadFeedHistoryContext>
  );
}

export function ThreadHistoryScrollView({
  ref,
  ...props
}: ComponentPropsWithRef<typeof Animated.ScrollView>) {
  const history = useContext(ThreadFeedHistoryContext);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const offset = useScrollOffset(scrollRef);
  const attachScrollView = useCallback(
    (view: Animated.ScrollView | null) => {
      scrollRef(view);
      const cleanup = typeof ref === "function" ? ref(view) : undefined;
      if (ref && typeof ref !== "function") ref.current = view;
      return () => {
        scrollRef(null);
        if (typeof cleanup === "function") cleanup();
        else if (typeof ref === "function") ref(null);
        else if (ref) ref.current = null;
      };
    },
    [ref, scrollRef],
  );
  if (history === null)
    throw new Error("ThreadHistoryScrollView requires ThreadFeedHistoryProvider");
  const pull = history.pull;
  const topInset = history.topInset;
  const enabled = history.controls?.hasMoreHistory === true && !history.controls.loading;
  const loadEarlier = useEffectEvent(() => {
    if (history.controls?.hasMoreHistory && !history.controls.loading) {
      history.controls.onLoadEarlier();
    }
  });
  const gesture = useMemo(
    () =>
      // oxlint-disable-next-line react/capitalized-calls -- Gesture.Simultaneous is a gesture factory.
      Gesture.Simultaneous(
        // oxlint-disable-next-line react/capitalized-calls -- Gesture.Native is a gesture factory.
        Gesture.Native(),
        // Android clamps scroll offsets at zero, so measure the finger rather than scroll-view bounce.
        // oxlint-disable-next-line react/capitalized-calls -- Gesture.Pan is a gesture factory.
        Gesture.Pan()
          .enabled(enabled)
          .maxPointers(1)
          .activeOffsetY(10)
          .failOffsetX([-18, 18])
          .onBegin(() => {
            pull.set(
              reduceThreadHistoryPull(pull.get(), {
                type: "start",
                offset: offset.get() + topInset,
              }),
            );
          })
          .onUpdate((event) => {
            pull.set(
              reduceThreadHistoryPull(pull.get(), {
                type: "move",
                translationY: event.translationY,
                offset: offset.get() + topInset,
              }),
            );
          })
          .onEnd((event, success) => {
            if (!success) return;
            const moved = reduceThreadHistoryPull(pull.get(), {
              type: "move",
              translationY: event.translationY,
              offset: offset.get() + topInset,
            });
            const released = reduceThreadHistoryPull(moved, { type: "release" });
            pull.set(released);
            if (released.loadEarlier) runOnJS(loadEarlier)();
          })
          .onFinalize(() => {
            pull.set(reduceThreadHistoryPull(pull.get(), { type: "cancel" }));
          }),
      ),
    // oxlint-disable-next-line react/memo-dependencies -- runOnJS calls the current history controls through the effect event.
    [enabled, offset, pull, topInset, loadEarlier],
  );

  return (
    <GestureDetector gesture={gesture}>
      <Animated.ScrollView {...props} ref={attachScrollView} />
    </GestureDetector>
  );
}

export function ThreadFeedLoadEarlierControl(props: ThreadFeedHistoryControls) {
  const history = useContext(ThreadFeedHistoryContext);
  const { color } = useResolveClassNames("text-secondary-foreground");
  const pull = history?.pull;
  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: RING_CIRCUMFERENCE * (1 - (pull?.get().progress ?? 0)),
  }));
  if (!props.hasMoreHistory && props.error === null) return null;
  return (
    <View className="mb-3 items-center gap-1.5 px-2">
      {props.hasMoreHistory ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load earlier activity"
          accessibilityHint="Pull down until the circle fills, then release, or tap to load earlier activity."
          accessibilityState={{ disabled: props.loading, busy: props.loading }}
          disabled={props.loading}
          onPress={props.onLoadEarlier}
          className={cn(
            "min-h-12 flex-row items-center justify-center gap-2 self-center rounded-full px-6 active:opacity-70",
            props.loading ? "bg-subtle-strong" : "bg-secondary",
          )}
        >
          {props.loading ? (
            <AppActivityIndicator colorClassName="accent-foreground-muted" />
          ) : (
            <View
              className="size-6 items-center justify-center"
              pointerEvents="none"
              accessible={false}
            >
              <Svg width={24} height={24} style={{ position: "absolute" }}>
                <Circle
                  cx={12}
                  cy={12}
                  r={10}
                  stroke={color}
                  strokeWidth={1.5}
                  opacity={0.2}
                  fill="none"
                />
                <AnimatedCircle
                  cx={12}
                  cy={12}
                  r={10}
                  stroke={color}
                  strokeWidth={1.5}
                  fill="none"
                  strokeDasharray={[RING_CIRCUMFERENCE, RING_CIRCUMFERENCE]}
                  rotation={-90}
                  origin="12, 12"
                  animatedProps={animatedProps}
                />
              </Svg>
              <SymbolView name="chevron.up" size={14} tintColor={color} />
            </View>
          )}
          <AppText
            className={cn(
              "min-w-0 shrink text-center font-t3-medium",
              props.loading ? "text-foreground-muted" : "text-secondary-foreground",
            )}
          >
            {props.loading ? "Loading earlier activity…" : "Load earlier activity"}
          </AppText>
        </Pressable>
      ) : null}
      {props.error !== null ? (
        <AppText className="text-center text-xs text-icon-subtle">{props.error}</AppText>
      ) : null}
    </View>
  );
}

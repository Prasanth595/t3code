import type { JSX } from "react";
import { Platform, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useThreadDetailsDrawer, useThreadListDrawer } from "./thread-list-drawer";

export const THREAD_FLOATING_CONTROL_TOP_GAP = 8;
export const THREAD_FLOATING_CONTROL_SIZE = 44;
/** Distance from the top safe-area inset to the bottom of the floating row. */
export const THREAD_FLOATING_CONTROL_ROW_OFFSET =
  THREAD_FLOATING_CONTROL_TOP_GAP + THREAD_FLOATING_CONTROL_SIZE;
/** Extra tail past the pill row where the top scrim finishes fading out. */
const THREAD_FLOATING_TOP_SCRIM_TAIL = 24;

const CONTROLS_ENTERING = FadeIn.duration(160).reduceMotion(ReduceMotion.System);
const CONTROLS_EXITING = FadeOut.duration(160).reduceMotion(ReduceMotion.System);

const PILL_CLASS_NAME =
  "items-center justify-center rounded-full border border-header-border bg-header/90";
const PILL_STYLE = { width: THREAD_FLOATING_CONTROL_SIZE, height: THREAD_FLOATING_CONTROL_SIZE };

/**
 * ChatGPT-style top scrim for the floating-controls thread screens: an opaque
 * header-colored band over the status bar fading to transparent below the pill
 * row, so scrolled content dissolves instead of colliding with the status bar.
 */
export function ThreadFloatingTopScrim(): JSX.Element {
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const height = insets.top + THREAD_FLOATING_CONTROL_ROW_OFFSET + THREAD_FLOATING_TOP_SCRIM_TAIL;
  const topColor = themeColorWithAlpha(theme["--color-header"], 1);
  // Solid through the status bar and up to the pill row's top gap, then linear to clear.
  const backgroundImage = `linear-gradient(to bottom, ${topColor} 0px, ${topColor} ${
    insets.top + THREAD_FLOATING_CONTROL_TOP_GAP
  }px, rgba(0, 0, 0, 0) ${height}px)`;
  return (
    <View
      pointerEvents="none"
      className="absolute inset-x-0 top-0 z-10"
      style={{ height, experimental_backgroundImage: backgroundImage }}
    />
  );
}

/**
 * The Android phone thread screen hides the Material header and floats its
 * controls over the feed. Split view and every other platform keep the header.
 */
export function usesFloatingThreadControls(layout: { readonly usesSplitView: boolean }): boolean {
  return Platform.OS === "android" && !layout.usesSplitView;
}

/** Two floating pills over the feed: threads on the left, details on the right. */
export function ThreadFloatingHeader(props: {
  /** Hidden while the composer owns the keyboard so the pills never cover it. */
  readonly hidden: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { openDrawer } = useThreadListDrawer();
  const details = useThreadDetailsDrawer();

  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-3"
      style={{ top: insets.top + THREAD_FLOATING_CONTROL_TOP_GAP, zIndex: 20 }}
    >
      {props.hidden ? null : (
        <Animated.View
          entering={CONTROLS_ENTERING}
          exiting={CONTROLS_EXITING}
          pointerEvents="box-none"
          className="flex-row items-center justify-between"
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open threads"
            className={PILL_CLASS_NAME}
            style={PILL_STYLE}
            onPress={openDrawer}
          >
            <SymbolView
              name="line.3.horizontal"
              size={24}
              tintColorClassName="accent-header-foreground"
              type="monochrome"
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open thread details"
            accessibilityState={{ expanded: details.open }}
            className={PILL_CLASS_NAME}
            style={PILL_STYLE}
            onPress={details.openDrawer}
          >
            <SymbolView
              name="sidebar.right"
              size={24}
              tintColorClassName="accent-header-foreground"
              type="monochrome"
            />
          </Pressable>
        </Animated.View>
      )}
    </View>
  );
}

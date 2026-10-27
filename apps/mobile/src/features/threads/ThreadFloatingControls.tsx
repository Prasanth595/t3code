import type { MenuAction } from "@react-native-menu/menu";
import { useMemo } from "react";
import { Platform, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidAnchoredMenu } from "../../components/ui/AndroidAnchoredMenu";
import type { AppBarAction } from "../../components/ui/AppBar.types";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useThreadListDrawer } from "./thread-list-drawer";

export const THREAD_FLOATING_CONTROL_TOP_GAP = 8;
export const THREAD_FLOATING_CONTROL_SIZE = 44;
/** Distance from the top safe-area inset to the bottom of the floating row. */
export const THREAD_FLOATING_CONTROL_ROW_OFFSET =
  THREAD_FLOATING_CONTROL_TOP_GAP + THREAD_FLOATING_CONTROL_SIZE;

const CLOSE_THREAD_ACTION_ID = "close-thread";

const CONTROLS_ENTERING = FadeIn.duration(160).reduceMotion(ReduceMotion.System);
const CONTROLS_EXITING = FadeOut.duration(160).reduceMotion(ReduceMotion.System);

const PILL_CLASS_NAME =
  "items-center justify-center rounded-full border border-header-border bg-header/90";
const PILL_STYLE = { width: THREAD_FLOATING_CONTROL_SIZE, height: THREAD_FLOATING_CONTROL_SIZE };

/**
 * The Android phone thread screen hides the Material header and floats its
 * controls over the feed. Split view and every other platform keep the header.
 */
export function usesFloatingThreadControls(layout: { readonly usesSplitView: boolean }): boolean {
  return Platform.OS === "android" && !layout.usesSplitView;
}

/** Two floating pills over the feed: threads list on the left, thread actions on the right. */
export function ThreadFloatingHeader(props: {
  readonly actions: ReadonlyArray<AppBarAction>;
  readonly onCloseThread: () => void;
  /** Hidden while the composer owns the keyboard so the pills never cover it. */
  readonly hidden: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { openDrawer } = useThreadListDrawer();
  const { actions, onCloseThread } = props;
  const menuActions = useMemo<ReadonlyArray<MenuAction>>(() => {
    const entries: MenuAction[] = [{ id: CLOSE_THREAD_ACTION_ID, title: "Close thread" }];
    for (const action of actions) {
      entries.push({
        id: action.accessibilityLabel,
        title: action.accessibilityLabel,
        ...(action.selected === undefined ? {} : { state: action.selected ? "on" : "off" }),
      });
    }
    return entries;
  }, [actions]);
  const pressMenuAction = (id: string) => {
    if (id === CLOSE_THREAD_ACTION_ID) {
      onCloseThread();
      return;
    }
    actions.find((action) => action.accessibilityLabel === id)?.onPress();
  };

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
          <AndroidAnchoredMenu
            actions={menuActions}
            onPressAction={({ nativeEvent }) => pressMenuAction(nativeEvent.event)}
          >
            {(open) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Thread options"
                className={PILL_CLASS_NAME}
                style={PILL_STYLE}
                onPress={open}
              >
                <SymbolView
                  name="ellipsis"
                  size={24}
                  tintColorClassName="accent-header-foreground"
                  type="monochrome"
                />
              </Pressable>
            )}
          </AndroidAnchoredMenu>
        </Animated.View>
      )}
    </View>
  );
}

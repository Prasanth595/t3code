import {
  useAnimatedStyle,
  useDerivedValue,
  withSpring,
  withTiming,
  ReduceMotion,
} from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { COMPOSER_SPRING } from "../../components/composerMotion";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useContext, useEffect, useState } from "react";
import { BackHandler, Platform, useWindowDimensions } from "react-native";
import { useComposerKeyboardMotion } from "./use-composer-keyboard-motion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { composerEditorHeight } from "./composerEditorHeight";

/** Shares sizing between the new-task and existing-thread editors. */
export function useComposerEditorSize({
  hasAttachments,
  extraChrome = 0,
  active = true,
  bottomPadding,
}: {
  hasAttachments: boolean;
  extraChrome?: number;
  active?: boolean;
  bottomPadding: { closed: number; opened: number };
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext) || insets.top + 56;
  const keyboard = useComposerKeyboardMotion();
  const { height: keyboardHeight, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const { lineHeight } = useScaledTextRole("body");
  const [contentHeight, setContentHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const attachmentSize = expanded ? 72 : 56;
  const closedBottomPadding = bottomPadding.closed;
  const openedBottomPadding = bottomPadding.opened;
  const animatedBottomPadding = useDerivedValue(
    () =>
      closedBottomPadding + (openedBottomPadding - closedBottomPadding) * keyboardProgress.value,
  );
  const availableHeight =
    height -
    headerHeight -
    keyboard.height -
    (keyboard.height > 0 ? openedBottomPadding : closedBottomPadding) -
    100 -
    extraChrome -
    (hasAttachments ? 66 : 0);

  useEffect(() => {
    if (!expanded) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setExpanded(false);
      return true;
    });
    return () => subscription.remove();
  }, [expanded]);

  const inlineHeight = composerEditorHeight({
    contentHeight,
    availableHeight,
    lineHeight,
  });
  const activeTarget = active || expanded ? 1 : 0;
  const focusProgress = useDerivedValue(() =>
    Platform.OS === "ios"
      ? withTiming(activeTarget, { duration: 220, reduceMotion: ReduceMotion.System })
      : activeTarget,
  );
  const expansionTarget = expanded ? 1 : 0;
  const expansion = useDerivedValue(() => withSpring(expansionTarget, COMPOSER_SPRING));
  const attachmentHeight = hasAttachments ? attachmentSize + 10 : 0;
  const animatedAttachmentHeight = useDerivedValue(() =>
    withSpring(attachmentHeight, COMPOSER_SPRING),
  );
  const expandedViewportHeight = height - headerHeight - 64 - extraChrome;
  const editorStyle = useAnimatedStyle(() => {
    const expandedHeight = Math.max(
      lineHeight + 8,
      expandedViewportHeight -
        animatedAttachmentHeight.value +
        keyboardHeight.value -
        animatedBottomPadding.value,
    );
    return {
      height:
        36 +
        focusProgress.value * (inlineHeight - 36) +
        expansion.value * (expandedHeight - inlineHeight),
    };
  });
  const attachmentStyle = useAnimatedStyle(() => ({
    height: animatedAttachmentHeight.value,
    overflow: "hidden",
  }));
  const gutterStyle = useAnimatedStyle(() => ({
    paddingHorizontal: withSpring(expanded ? 0 : 12, COMPOSER_SPRING),
  }));

  return {
    expanded,
    setExpanded,
    setContentHeight,
    scrollEnabled: expanded || (active && Math.ceil(contentHeight) + 8 > inlineHeight),
    attachmentSize,
    editorStyle,
    attachmentStyle,
    gutterStyle,
  };
}

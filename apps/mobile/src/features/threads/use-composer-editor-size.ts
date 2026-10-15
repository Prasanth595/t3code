import { useAnimatedStyle, useDerivedValue, withSpring } from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { COMPOSER_SPRING } from "../../components/composerMotion";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useContext, useEffect, useState } from "react";
import { BackHandler, useWindowDimensions } from "react-native";
import { useComposerKeyboardMotion } from "./use-composer-keyboard-motion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { composerEditorHeight } from "./composerEditorHeight";

/** Shares sizing between the new-task and existing-thread editors. */
export function useComposerEditorSize(
  hasAttachments: boolean,
  extraChrome = 0,
  viewportHeight?: number,
  active = true,
  bottomPadding?: { readonly closed: number; readonly opened: number },
) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext) || insets.top + 56;
  const keyboard = useComposerKeyboardMotion();
  const { height: keyboardHeight, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const { lineHeight } = useScaledTextRole("body");
  const [contentHeight, setContentHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const attachmentSize = expanded ? 72 : 56;
  const closedBottomPadding = bottomPadding?.closed ?? insets.bottom;
  const openedBottomPadding = bottomPadding?.opened ?? 0;
  const animatedBottomPadding = useDerivedValue(
    () =>
      closedBottomPadding + (openedBottomPadding - closedBottomPadding) * keyboardProgress.value,
  );
  const availableHeight =
    (viewportHeight ?? height - headerHeight) -
    keyboard.height -
    (keyboard.height > 0 ? openedBottomPadding : closedBottomPadding) -
    (expanded ? 64 : 100) -
    extraChrome -
    (hasAttachments ? attachmentSize + 10 : 0);

  useEffect(() => {
    if (!expanded) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setExpanded(false);
      return true;
    });
    return () => subscription.remove();
  }, [expanded]);

  const editorHeight = active
    ? composerEditorHeight({
        contentHeight,
        availableHeight,
        lineHeight,
        expanded,
      })
    : 36;
  const inlineHeight = active
    ? composerEditorHeight({
        contentHeight,
        availableHeight: availableHeight - (expanded ? 36 : 0),
        lineHeight,
        expanded: false,
      })
    : 36;
  const expansionTarget = active && expanded ? 1 : 0;
  const expansion = useDerivedValue(() => withSpring(expansionTarget, COMPOSER_SPRING));
  const attachmentHeight = hasAttachments ? attachmentSize + 10 : 0;
  const animatedAttachmentHeight = useDerivedValue(() =>
    withSpring(attachmentHeight, COMPOSER_SPRING),
  );
  const expandedViewportHeight = (viewportHeight ?? height - headerHeight) - 64 - extraChrome;
  const editorStyle = useAnimatedStyle(() => {
    const expandedHeight = Math.max(
      lineHeight + 8,
      expandedViewportHeight -
        animatedAttachmentHeight.value +
        keyboardHeight.value -
        animatedBottomPadding.value,
    );
    return {
      height: inlineHeight + expansion.value * (expandedHeight - inlineHeight),
    };
  });
  const attachmentStyle = useAnimatedStyle(() => ({
    height: animatedAttachmentHeight.value,
    overflow: "hidden",
  }));
  const gutterStyle = useAnimatedStyle(() => ({
    paddingHorizontal: withSpring(expanded ? 0 : 16, COMPOSER_SPRING),
  }));

  return {
    expanded,
    animateLayout: !keyboard.moving,
    setExpanded,
    setContentHeight,
    scrollEnabled: active && (expanded || Math.ceil(contentHeight) + 8 > inlineHeight),
    attachmentSize,
    height: editorHeight,
    editorStyle,
    attachmentStyle,
    gutterStyle,
    bottomPadding: animatedBottomPadding,
  };
}

import type { PropsWithChildren } from "react";
import type { ViewProps } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Reanimated, { interpolate, useAnimatedStyle } from "react-native-reanimated";

type KeyboardStickyViewProps = PropsWithChildren<
  ViewProps & {
    readonly offset?: { readonly closed?: number; readonly opened?: number };
    readonly enabled?: boolean;
  }
>;

/**
 * react-native-keyboard-controller's sticky view, with the open offset tied to the keyboard's
 * height. After a fold the controller can settle at progress 1 with no keyboard, which left the
 * view shifted by its open offset.
 */
export function KeyboardStickyView({
  offset: { closed = 0, opened = 0 } = {},
  enabled = true,
  style,
  ...props
}: KeyboardStickyViewProps) {
  const { height, progress } = useReanimatedKeyboardAnimation();
  const stickyStyle = useAnimatedStyle(() => {
    const open = height.value < 0 ? progress.value : 0;
    return {
      transform: [
        {
          translateY: enabled ? height.value + interpolate(open, [0, 1], [closed, opened]) : closed,
        },
      ],
    };
  }, [closed, opened, enabled]);
  return <Reanimated.View style={[style, stickyStyle]} {...props} />;
}

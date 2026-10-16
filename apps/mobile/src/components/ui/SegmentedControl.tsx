import { useState } from "react";
import { I18nManager, Platform, Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, withTiming } from "react-native-reanimated";

import { AppText } from "./AppText";
import { useControlTheme } from "./useControlTheme";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

/** Shared capsule control with native press targets and a raised selection. */
export function SegmentedControl<Value extends string | number>(
  props: SegmentedControlProps<Value>,
) {
  const { colorScheme } = useControlTheme();
  const [width, setWidth] = useState(0);
  const reduceMotion = useReducedMotion();
  const selectedIndex = props.options.findIndex((option) => option.value === props.selected);
  const segmentWidth = props.options.length ? Math.max(0, width - 6) / props.options.length : 0;
  const selectionOffset = selectedIndex * segmentWidth * (I18nManager.isRTL ? -1 : 1);
  const selectionStyle = useAnimatedStyle(() => ({
    width: segmentWidth,
    transform: [{ translateX: withTiming(selectionOffset, { duration: reduceMotion ? 0 : 160 }) }],
  }));
  const dark = colorScheme === "dark";
  const minHeight = props.size === "compact" ? 32 : Platform.OS === "android" ? 40 : 36;

  return (
    <View collapsable={false} className={props.className}>
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        className="flex-row rounded-full border p-0.5"
        style={{
          minHeight,
          backgroundColor: dark ? "#111111" : "#e9e9e9",
          borderColor: dark ? "#303030" : "#d4d4d4",
        }}
      >
        {selectedIndex >= 0 && width > 0 ? (
          <Animated.View
            pointerEvents="none"
            className="absolute bottom-0.5 start-0.5 top-0.5 rounded-full border"
            style={[
              {
                backgroundColor: dark ? "#242424" : "#ffffff",
                borderColor: dark ? "#484848" : "#d4d4d4",
                boxShadow: "0px 2px 3px rgba(0, 0, 0, 0.25)",
              },
              selectionStyle,
            ]}
          />
        ) : null}
        {props.options.map((option) => {
          const selected = option.value === props.selected;
          return (
            <Pressable
              key={`${typeof option.value}:${option.value}`}
              accessibilityRole={props.role ?? "button"}
              accessibilityLabel={option.accessibilityLabel ?? option.label}
              accessibilityState={{ selected }}
              onPress={() => props.onSelect(option.value)}
              className="flex-1 items-center justify-center rounded-full px-2 py-1 active:opacity-70"
              style={{ minHeight: minHeight - 6 }}
            >
              <AppText
                textRole="footnote"
                className={selected ? "font-t3-bold" : "font-t3-medium"}
                style={{
                  color: selected ? (dark ? "#f5f5f5" : "#171717") : dark ? "#a3a3a3" : "#666666",
                }}
              >
                {option.label}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

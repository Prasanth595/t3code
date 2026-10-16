import { useState } from "react";
import { I18nManager, Platform, Pressable, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
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
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const { width, height } = layout;
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
        onLayout={(event) => setLayout(event.nativeEvent.layout)}
        className="flex-row rounded-full p-[3px]"
        style={{
          minHeight,
          boxShadow: dark ? "0px 1px 2px #00000062" : "0px 1px 2px #00000014",
        }}
      >
        <CapsuleSurface width={width} height={height} dark={dark} />
        {selectedIndex >= 0 && width > 0 ? (
          <Animated.View
            pointerEvents="none"
            className="absolute bottom-[3px] start-[3px] top-[3px] rounded-full"
            style={[
              {
                boxShadow: dark ? "0px 1px 2px #00000046" : "0px 1px 2px #0000000e",
              },
              selectionStyle,
            ]}
          >
            <CapsuleSurface width={segmentWidth} height={height - 6} dark={dark} selected />
          </Animated.View>
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

/** Pen's inset well and raised selection use opposite vertical edge lighting. */
function CapsuleSurface({
  width,
  height,
  dark,
  selected = false,
}: {
  width: number;
  height: number;
  dark: boolean;
  selected?: boolean;
}) {
  if (width <= 0 || height <= 0) return null;
  const fill = selected
    ? [dark ? "#1e1e1e" : "#fffffe", dark ? "#1e1e1e" : "#fffffe"]
    : dark
      ? ["#131313", "#161616"]
      : ["#f2f2f2", "#f6f6f6"];
  const edge: [string, string] = selected
    ? dark
      ? ["#ffffff38", "#ffffff05"]
      : ["#00000022", "#00000003"]
    : dark
      ? ["#00000099", "#ffffff29"]
      : ["#00000045", "#00000019"];
  return (
    <Svg
      pointerEvents="none"
      width={width}
      height={height}
      style={{ position: "absolute", top: 0, left: 0 }}
    >
      <Defs>
        <LinearGradient id="fill" x1="0" y1="0" x2="0%" y2="100%">
          <Stop offset="0" stopColor={fill[0]} />
          <Stop offset="1" stopColor={fill[1]} />
        </LinearGradient>
        <LinearGradient id="edge" x1="0" y1="0" x2="0%" y2="100%">
          <Stop
            offset="0"
            stopColor={edge[0].slice(0, 7)}
            stopOpacity={parseInt(edge[0].slice(7), 16) / 255}
          />
          <Stop
            offset="1"
            stopColor={edge[1].slice(0, 7)}
            stopOpacity={parseInt(edge[1].slice(7), 16) / 255}
          />
        </LinearGradient>
      </Defs>
      <Rect
        x={0.5}
        y={0.5}
        width={width - 1}
        height={height - 1}
        rx={(height - 1) / 2}
        fill="url(#fill)"
        stroke="url(#edge)"
        strokeWidth={1}
      />
    </Svg>
  );
}

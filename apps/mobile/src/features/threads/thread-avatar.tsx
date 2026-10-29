import { threadAvatar } from "@t3tools/client-runtime/thread-avatar";
import { memo, useMemo } from "react";
import { View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

const SIZE = 44;

export type ThreadAvatarIndicator = "working" | "attention" | "done" | null;

const INDICATOR_CLASS_NAME: Record<Exclude<ThreadAvatarIndicator, null>, string> = {
  working: "bg-adaptive-sky-600-400",
  attention: "bg-warning-foreground",
  done: "bg-adaptive-emerald-600-400",
};

export const ThreadAvatar = memo(function ThreadAvatar(props: {
  readonly seed: string;
  readonly title: string;
  readonly indicator: ThreadAvatarIndicator;
  readonly ringClassName: string;
}) {
  const avatar = useMemo(() => threadAvatar(props.seed, props.title), [props.seed, props.title]);
  const gradientId = `avatar-${props.seed}`;
  return (
    <View style={{ width: SIZE, height: SIZE }}>
      <Svg width={SIZE} height={SIZE} style={{ position: "absolute" }}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={avatar.from} />
            <Stop offset="1" stopColor={avatar.to} />
          </LinearGradient>
        </Defs>
        <Rect width={SIZE} height={SIZE} rx={SIZE / 2} fill={`url(#${gradientId})`} />
      </Svg>
      <View className="flex-1 items-center justify-center">
        <Text className="text-[17px] font-t3-bold" style={{ color: "rgba(30, 30, 40, 0.72)" }}>
          {avatar.initial}
        </Text>
      </View>
      {props.indicator ? (
        <View
          className={cn(
            "absolute -bottom-px -right-px h-3.5 w-3.5 rounded-full border-[2.5px]",
            INDICATOR_CLASS_NAME[props.indicator],
            props.ringClassName,
          )}
        />
      ) : null}
    </View>
  );
});

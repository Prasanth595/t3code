import { MOBILE_SHAPE } from "../../lib/designTokens";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { cn } from "../../lib/cn";
import { useThemeRadius, useThemeRaised } from "../../lib/forkThemeStyle";
import { AppText as Text } from "./AppText";

export function ListSection(props: {
  readonly title?: string;
  readonly titleIcon?: ReactNode;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: string;
}) {
  // Fork: a published theme sets the radius, the outline and the shadow (lib/forkThemeStyle.ts).
  const radius = useThemeRadius(
    Platform.OS === "android" ? MOBILE_SHAPE.group.android : MOBILE_SHAPE.group.ios,
  );
  const raised = useThemeRaised();
  return (
    <View className="gap-2">
      {props.title ? (
        <View className="flex-row items-center justify-between gap-3">
          <View
            className={
              Platform.OS === "android"
                ? "min-w-0 flex-1 flex-row items-center gap-2 px-4"
                : "min-w-0 flex-1 flex-row items-center gap-2 px-2"
            }
          >
            {props.titleIcon}
            <Text textRole="footnote" className="shrink font-t3-medium text-foreground-muted">
              {props.title}
            </Text>
          </View>
          {props.trailing}
        </View>
      ) : null}
      <View
        className={cn("overflow-hidden border-continuous bg-grouped-card", raised.className)}
        style={[{ borderRadius: radius }, raised.style]}
      >
        {props.children}
      </View>
      {props.footer ? (
        <Text textRole="footnote" className="px-4 text-foreground-muted">
          {props.footer}
        </Text>
      ) : null}
    </View>
  );
}

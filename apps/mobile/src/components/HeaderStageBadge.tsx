import { NATIVE_WORKSPACE_COLUMNS_SUPPORTED } from "../native/NativeWorkspaceColumns";
import Constants from "expo-constants";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Platform, View } from "react-native";

import { AppText as Text } from "./ui/AppText";
import { IPAD_HOME_TITLE_OFFSET } from "../lib/layoutMetrics";
import { resolveMobileStageLabel } from "../lib/mobileBranding";
import { useAndroidControlSizing } from "./ui/useAndroidControlSizing";

const BADGE_MAX_FONT_SCALE = 1.4;

export function headerTitleOffset(): number {
  if (Platform.OS !== "ios") return 0;
  return Platform.isPad && !NATIVE_WORKSPACE_COLUMNS_SUPPORTED ? IPAD_HOME_TITLE_OFFSET : 0;
}

/**
 * The header's screen heading, visible only as the Dev or Nightly badge. Release builds still
 * render this view: without it the native header falls back to its plain-text title.
 */
export function HeaderStageBadge(props: {
  readonly screenTitle: string;
  readonly allowFontScaling?: boolean;
}) {
  const stageLabel = resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant);
  const { scale } = useAndroidControlSizing();

  return (
    <View
      aria-level={1}
      accessibilityLabel={
        stageLabel === null ? props.screenTitle : `${props.screenTitle}, ${stageLabel} build`
      }
      accessible
      role="heading"
      className="min-h-px min-w-px self-start"
      style={{ marginLeft: headerTitleOffset() }}
    >
      {stageLabel === null ? null : (
        <View
          className="rounded-full bg-subtle px-1.5 py-0.5"
          style={
            Platform.OS === "android"
              ? { paddingHorizontal: 5.25 * scale, paddingVertical: 1.75 * scale }
              : undefined
          }
        >
          <Text
            allowFontScaling={props.allowFontScaling}
            maxFontSizeMultiplier={BADGE_MAX_FONT_SCALE}
            className="font-t3-bold text-foreground-muted uppercase"
            style={{ fontSize: 9 * scale, letterSpacing: 0.9 * scale }}
          >
            {stageLabel}
          </Text>
        </View>
      )}
    </View>
  );
}

const THREADS_TITLE = "Threads";

function renderHeaderStageBadge() {
  return <HeaderStageBadge allowFontScaling={Platform.OS === "ios"} screenTitle={THREADS_TITLE} />;
}

export function getStageBadgeHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  return {
    headerTitle: renderHeaderStageBadge,
    headerTitleStyle: fallbackTitleStyle,
    title: THREADS_TITLE,
    unstable_headerLeftItems: undefined,
  };
}

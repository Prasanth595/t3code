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

/** Marks Dev and Nightly builds; release builds show nothing in this slot. */
export function HeaderStageBadge(props: { readonly allowFontScaling?: boolean } = {}) {
  const stageLabel = resolveMobileStageLabel(Constants.expoConfig?.extra?.appVariant);
  const { scale } = useAndroidControlSizing();
  if (stageLabel === null) return null;

  return (
    <View
      accessibilityLabel={`${stageLabel} build`}
      accessible
      className="self-start rounded-full bg-subtle px-1.5 py-0.5"
      style={[
        { marginLeft: headerTitleOffset() },
        Platform.OS === "android" && {
          paddingHorizontal: 5.25 * scale,
          paddingVertical: 1.75 * scale,
        },
      ]}
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
  );
}

function renderHeaderStageBadge() {
  return <HeaderStageBadge allowFontScaling={Platform.OS === "ios"} />;
}

export function getStageBadgeHeaderOptions(
  fallbackTitleStyle?: NativeStackNavigationOptions["headerTitleStyle"],
): NativeStackNavigationOptions {
  return {
    headerTitle: renderHeaderStageBadge,
    headerTitleStyle: fallbackTitleStyle,
    title: "Threads",
    unstable_headerLeftItems: undefined,
  };
}

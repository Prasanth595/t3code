import { requireOptionalNativeModule } from "expo";
import { useCallback } from "react";
import { Platform, useWindowDimensions } from "react-native";

const nativeControls =
  Platform.OS === "android"
    ? requireOptionalNativeModule<{ scaledFontSize?: (size: number) => number }>("T3NativeControls")
    : null;

/** Custom text renderers need the same scaled size for glyphs and their layout geometry. */
export function useSystemFontScale() {
  const { fontScale } = useWindowDimensions();
  return useCallback(
    (size: number) => nativeControls?.scaledFontSize?.(size) ?? size * fontScale,
    [fontScale],
  );
}

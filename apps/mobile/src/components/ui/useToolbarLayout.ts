import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useScaledTextRole } from "../../features/settings/appearance/useScaledTextRole";
import { useSystemFontScale } from "../../lib/useSystemFontScale";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

/**
 * Shared Android header geometry; class-based spacing uses the app's 14dp rem.
 * `singleLine` sizes the toolbar for a title row with the subtitle inline.
 */
export function useToolbarLayout(embedded = false, singleLine = false) {
  const insets = useSafeAreaInsets();
  const title = useScaledTextRole("title");
  const subtitle = useScaledTextRole("label");
  const { scale } = useAndroidControlSizing();
  const scaleSystemFont = useSystemFontScale();
  const titleLineHeight = scaleSystemFont(title.lineHeight);
  const subtitleLineHeight = scaleSystemFont(subtitle.lineHeight);
  return {
    height: Math.ceil(
      singleLine
        ? Math.max(48, 48 * scale, titleLineHeight + 1)
        : Math.max(48, 56 * scale, titleLineHeight + subtitleLineHeight + 1),
    ),
    paddingTop: embedded ? 8 * scale : Math.max(insets.top, 12 * scale),
    paddingBottom: 7 * scale,
  };
}

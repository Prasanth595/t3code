import { Platform } from "react-native";

import { FONT_FAMILIES as BUNDLED_FONT_FAMILIES } from "./fontFamilies";
import { useThemeStyle } from "./forkThemeStyle";

const FONT_FAMILIES = {
  ...BUNDLED_FONT_FAMILIES,
  mono: Platform.OS === "ios" ? "Menlo" : "monospace",
} as const;

export function useFontFamily(weight: keyof typeof FONT_FAMILIES): string {
  // Fork: a published theme can pick bundled fonts (lib/forkPublishedThemes.ts).
  return useThemeStyle().fonts?.[weight] ?? FONT_FAMILIES[weight];
}

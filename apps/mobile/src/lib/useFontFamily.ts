import { Platform } from "react-native";

import { useThemeStyle } from "./forkThemeStyle";

const FONT_FAMILIES = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  bold: "DMSans-Bold",
  mono: Platform.OS === "ios" ? "Menlo" : "monospace",
} as const;

export function useFontFamily(weight: keyof typeof FONT_FAMILIES): string {
  // Fork: a published theme can pick bundled fonts (lib/forkPublishedThemes.ts).
  return useThemeStyle().fonts?.[weight] ?? FONT_FAMILIES[weight];
}

import { useSyncExternalStore } from "react";

import {
  getSystemColorsTheme,
  setSystemAccentColor,
  subscribeToCustomThemes,
} from "../themePalette";
import { refreshTheme } from "./useTheme";

/** The System colors theme, or null outside a desktop that can report its accent. */
export function useSystemColorsTheme() {
  return useSyncExternalStore(subscribeToCustomThemes, getSystemColorsTheme, () => null);
}

/** Repaints the active theme when the desktop's accent changes. */
export function startSystemAccentSync(): () => void {
  const subscribe = window.desktopBridge?.onSystemAccentColorChange;
  if (!subscribe) return () => {};
  return subscribe((accent) => {
    setSystemAccentColor(accent);
    refreshTheme({ preservePreview: true });
  });
}

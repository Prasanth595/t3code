import { useSyncExternalStore } from "react";

import {
  getSystemColorsTheme,
  setSystemAccentColor,
  subscribeToCustomThemes,
} from "../themePalette";
import { refreshTheme } from "./useTheme";

export function useSystemColorsTheme() {
  return useSyncExternalStore(subscribeToCustomThemes, getSystemColorsTheme, () => null);
}

export function startSystemAccentSync(): () => void {
  const subscribe = window.desktopBridge?.onSystemAccentColorChange;
  if (!subscribe) return () => {};
  return subscribe((accent) => {
    setSystemAccentColor(accent);
    refreshTheme({ preservePreview: true });
  });
}

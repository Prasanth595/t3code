import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";
import { useMemo, useSyncExternalStore } from "react";

import { appearanceFontStack } from "../appearanceFonts";
import {
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  resolveThemeHalf,
  subscribeToCustomThemes,
  themeColorToHex,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
} from "../themePalette";
import { useClientSettings } from "./useSettings";
import { useRenderedAppearance, useTheme } from "./useTheme";

/** The palette `applyTheme` paints for a preference, or the stock look when no theme applies. */
function resolveActiveThemeColors(
  theme: ThemePreference,
  halves: ThemeHalves | null,
  appearance: ThemeAppearance,
) {
  const definition = getThemeDefinition(resolveThemeHalf(theme, halves, appearance));
  return definition === null
    ? getStandardThemeColors(appearance)
    : (getThemeColorsForMode(definition, appearance) ?? getStandardThemeColors(appearance));
}

/** The app's active theme and fonts, as handed to agent HTML renders. Stable until one changes. */
export function useHtmlRenderTheme() {
  const { theme, themeHalves } = useTheme();
  const renderedAppearance = useRenderedAppearance();
  // Custom and published palettes can be edited in place, under an unchanged preference.
  const colors = useSyncExternalStore(
    subscribeToCustomThemes,
    () => resolveActiveThemeColors(theme, themeHalves, renderedAppearance),
    () => getStandardThemeColors(renderedAppearance),
  );
  const sans = useClientSettings((settings) => settings.fontFamilySans);
  const mono = useClientSettings((settings) => settings.fontFamilyCode);
  return useMemo(
    () =>
      htmlRenderTheme(
        Object.fromEntries(
          Object.entries(colors).map(([role, color]) => [role, themeColorToHex(color) ?? color]),
        ) as typeof colors,
        renderedAppearance,
        {
          sans: appearanceFontStack(sans, HTML_RENDER_DEFAULT_FONTS.sans),
          mono: appearanceFontStack(mono, HTML_RENDER_DEFAULT_FONTS.mono),
        },
      ),
    [colors, renderedAppearance, sans, mono],
  );
}

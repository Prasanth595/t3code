import {
  background,
  border,
  clip,
  dropShadow,
  type ModifierConfig,
} from "@expo/ui/jetpack-compose/modifiers";
import { createContext, use, useMemo } from "react";
import type { ViewStyle } from "react-native";

import { NO_STYLE, parseThemeShadow, type PublishedMobileThemeStyle } from "./forkPublishedThemes";

/**
 * Fork: the style fields of the active published theme. `AppearancePreferencesProvider` sets it.
 * Outside the provider, the stock style applies.
 */
export const ThemeStyleContext = createContext<PublishedMobileThemeStyle>(NO_STYLE);

export function useThemeStyle(): PublishedMobileThemeStyle {
  return use(ThemeStyleContext);
}

/*
 * Fork: shape hooks for styles that a class name cannot reach, such as computed or animated
 * styles. Class names follow the theme through the tokens in `fork-theme.css`.
 */

/** The theme radius, or `stock` when the active theme sets none. */
export function useThemeRadius(stock: number): number {
  return useThemeStyle().radius ?? stock;
}

/**
 * The theme outline and hard shadow of a raised surface, such as the composer or a grouped list:
 * a class name for the outline, which takes its width from the border token, and a style for
 * the shadow. Both are undefined for a theme that sets neither, so the stock look stays.
 */
export function useThemeRaised(): {
  readonly className: string | undefined;
  readonly style: ViewStyle | undefined;
} {
  const { borderWidth, shadow } = useThemeStyle();
  return useMemo(
    () => ({
      className: borderWidth === undefined ? undefined : "border border-border",
      style: shadow === undefined ? undefined : { boxShadow: shadow },
    }),
    [borderWidth, shadow],
  );
}

/**
 * The theme shape of a Jetpack Compose control, such as a floating action button: the theme
 * radius as a clip, which also hides the stock elevation shadow, the outline and the hard shadow.
 * The container color fills the corners that the stock control shape leaves inside the clip.
 *
 * Known limit: a theme without a radius keeps the stock control, because the outline and the
 * shadow need a known shape. Revisit when a theme sets a shadow or a border without a radius.
 */
export function useThemeComposeModifiers(
  borderColor: string,
  containerColor: string,
  raised = true,
): ReadonlyArray<ModifierConfig> {
  const { radius, borderWidth, shadow } = useThemeStyle();
  return useMemo(() => {
    if (radius === undefined) return [];
    const shape = { type: "roundedCorner", radius } as const;
    const parsed = shadow === undefined || !raised ? null : parseThemeShadow(shadow);
    return [
      ...(parsed
        ? [
            dropShadow(shape, {
              offsetX: parsed.offsetX,
              offsetY: parsed.offsetY,
              radius: parsed.radius,
              spread: parsed.spread,
              color: parsed.color,
            }),
          ]
        : []),
      clip(shape),
      background(containerColor),
      ...(borderWidth ? [border(borderWidth, borderColor)] : []),
    ];
  }, [borderColor, borderWidth, containerColor, radius, raised, shadow]);
}

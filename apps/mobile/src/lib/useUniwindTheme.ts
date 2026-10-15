import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { MobileThemeVariables } from "./mobileTheme";

/**
 * Ordinary React Native rendering must use className.
 *
 * This bridge follows the same single React theme commit as the root
 * ScopedTheme instead of subscribing every consumer to CSS-variable updates.
 */
export function useUniwindTheme(): MobileThemeVariables {
  return useAppearancePreferences().themeVariables;
}

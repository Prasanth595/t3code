import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { getMobileFontFamilies } from "./fontFamilies";

export function useThemeFontFamilies() {
  return getMobileFontFamilies(useAppearancePreferences().themeId);
}

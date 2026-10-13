import {
  flattenThemeColor,
  themeColorWithContrast,
  type MobileThemeVariables,
} from "../../lib/mobileTheme";

/** Both navigation positions keep a visible tonal selection against their actual surface. */
export function androidWorkspaceNavigationColors(colors: MobileThemeVariables, rail: boolean) {
  const header = flattenThemeColor(colors["--color-header"], colors["--color-screen"]);
  const containerColor = rail
    ? header
    : flattenThemeColor(colors["--color-secondary"], colors["--color-screen"]);
  const indicatorColor = themeColorWithContrast(
    flattenThemeColor(colors["--color-secondary"], containerColor),
    containerColor,
    1.5,
  );
  return {
    containerColor,
    indicatorColor,
    selectedColor: themeColorWithContrast(
      flattenThemeColor(colors["--color-secondary-foreground"], indicatorColor),
      [indicatorColor, containerColor],
    ),
    unselectedColor: rail
      ? flattenThemeColor(colors["--color-header-foreground"], containerColor)
      : themeColorWithContrast(
          flattenThemeColor(colors["--color-secondary-foreground"], containerColor),
          containerColor,
        ),
  };
}

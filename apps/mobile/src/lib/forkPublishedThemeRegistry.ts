import type { ThemeAppearance, ThemeColors } from "@t3tools/shared/themePalettes";

/**
 * Fork: the mobile theme id of a theme that a server publishes. The prefix keeps it apart from
 * the built-in ids in stored preferences.
 */
export type PublishedMobileThemeId = `published:${string}`;

const PREFIX = "published:";

export function publishedMobileThemeId(environmentThemeId: string): PublishedMobileThemeId {
  return `${PREFIX}${environmentThemeId}`;
}

export function isPublishedMobileThemeId(value: unknown): value is PublishedMobileThemeId {
  return typeof value === "string" && value.startsWith(PREFIX) && value.length > PREFIX.length;
}

type PublishedPalettes = ReadonlyMap<
  PublishedMobileThemeId,
  Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>
>;

const publishedPalettes = new Map<
  PublishedMobileThemeId,
  Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>
>();

/**
 * Fork: the palettes of the published themes, for the palette lookups by theme id in
 * `mobileTheme.ts`. Like web `setEnvironmentThemes`, one module store keeps those lookups pure
 * functions of the id. It only adds and replaces entries: a theme that no server offers never
 * reaches a lookup, because `availableMobileThemeIds` swaps its id for the stock theme first.
 *
 * Known limit: a view that memoizes on the theme id, such as the terminal, keeps the old colors
 * when a server republishes a theme under the same id, until the id or the appearance changes.
 */
export function registerPublishedMobileThemePalettes(palettes: PublishedPalettes): void {
  for (const [id, colors] of palettes) publishedPalettes.set(id, colors);
}

export function publishedMobileThemePalette(
  themeId: PublishedMobileThemeId,
  appearance: ThemeAppearance,
): ThemeColors | null {
  return publishedPalettes.get(themeId)?.[appearance] ?? null;
}

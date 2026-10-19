import type { EnvironmentId, EnvironmentTheme, ServerConfig } from "@t3tools/contracts";
import {
  RESERVED_THEME_IDS,
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
} from "@t3tools/shared/themePalettes";
import { processColor } from "react-native";

import { FORK_THEME_FONTS } from "./forkThemeFonts";
import {
  isPublishedMobileThemeId,
  publishedMobileThemeId,
  type PublishedMobileThemeId,
} from "./forkPublishedThemeRegistry";
import {
  DEFAULT_MOBILE_THEME_ID,
  themeColorToNativeColor,
  type MobileThemeId,
  type MobileThemeIds,
} from "./mobileTheme";

/**
 * Fork: the native font families that a published theme picks. Absent fields keep the stock font.
 *
 * Known limit: the composer takes the `sans` font, and the terminal and diff views keep the
 * platform monospace font. Revisit when a theme sets `fonts.composer` or `fonts.terminal` apart.
 */
export interface PublishedMobileThemeFonts {
  readonly regular?: string;
  readonly medium?: string;
  readonly bold?: string;
  readonly mono?: string;
}

/** Fork: the style fields of a published theme in native units. Absent fields keep the stock look. */
export interface PublishedMobileThemeStyle {
  readonly radius?: number;
  readonly borderWidth?: number;
  /** A CSS `box-shadow`, which React Native reads as the `boxShadow` style. */
  readonly shadow?: string;
  readonly fonts?: PublishedMobileThemeFonts;
  readonly canvasPattern?: {
    readonly kind: "dots" | "grid";
    /** Null: the theme sets no color, so the pattern uses the foreground color. */
    readonly color: string | null;
  };
}

export interface PublishedMobileTheme {
  readonly id: PublishedMobileThemeId;
  readonly label: string;
  /** The appearances that the theme has colors for, in light, dark order. */
  readonly appearances: ReadonlyArray<ThemeAppearance>;
  readonly colors: Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>;
  readonly style: PublishedMobileThemeStyle;
}

export const NO_STYLE: PublishedMobileThemeStyle = {};

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);

/** A color that React Native draws, or null. OKLCH becomes sRGB first, because RN does not read it. */
function nativeThemeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = themeColorToNativeColor(value.trim());
  return processColor(color) == null ? null : color;
}

function colorOverrides(
  values: Readonly<Record<string, string | undefined>>,
): Partial<Record<ThemeColorRole, string>> {
  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, value] of Object.entries(values)) {
    const color = nativeThemeColor(value);
    if (THEME_COLOR_ROLE_SET.has(role) && color !== null) {
      overrides[role as ThemeColorRole] = color;
    }
  }
  return overrides;
}

/**
 * The palette of `theme` for `appearance`, or null when the theme has no colors for it. The
 * listed colors go on top of the stock palette of that appearance.
 *
 * Known limit: web derives the roles that a theme does not list from `canvas` and `accent` with
 * the generator in `apps/web/src/themePalette.ts`. Mobile takes the stock role instead, so a theme
 * that lists only `canvas` and `accent` gets only those two colors here. Revisit when such a theme
 * is in use on a phone, or when upstream moves the generator to `packages/shared`.
 */
export function publishedThemeColors(
  theme: EnvironmentTheme,
  appearance: ThemeAppearance,
): ThemeColors | null {
  const isBase = appearance === theme.appearance;
  const listed = isBase ? theme.colors : theme.variants?.[appearance];
  if (!isBase && listed === undefined) return null;
  const stock = appearance === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS;
  const seeds = isBase ? { canvas: theme.canvas, accent: theme.accent } : {};
  return { ...stock, ...colorOverrides({ ...seeds, ...listed }) };
}

/** Same rule as web `publishedThemeDefinitions`: reserved ids never render, and a theme needs colors. */
function isUsablePublishedTheme(theme: EnvironmentTheme): boolean {
  if (RESERVED_THEME_IDS.has(theme.id)) return false;
  if (theme.canvas !== undefined && theme.accent !== undefined) return true;
  const otherAppearance = theme.appearance === "dark" ? "light" : "dark";
  return [theme.colors, theme.variants?.[otherAppearance]].some(
    (colors) => colors !== undefined && Object.keys(colorOverrides(colors)).length > 0,
  );
}

const ROOT_FONT_SIZE = 16;

/** `EnvironmentThemeLength` (`0`, `2px`, `0.5rem`, `1em`) in density-independent pixels. */
function lengthToPixels(length: string | undefined): number | undefined {
  if (length === undefined) return undefined;
  const value = Number.parseFloat(length);
  if (!Number.isFinite(value)) return undefined;
  return length.endsWith("rem") || length.endsWith("em") ? value * ROOT_FONT_SIZE : value;
}

function cssFontFamilies(value: string): ReadonlyArray<string> {
  return value
    .split(",")
    .map((family) => family.trim().replaceAll('"', "").replaceAll("'", "").toLowerCase())
    .filter((family) => family.length > 0);
}

/** The first bundled font of `kind` that the CSS family list names. */
function bundledFont<Kind extends (typeof FORK_THEME_FONTS)[number]["kind"]>(
  value: string | undefined,
  kind: Kind,
): Extract<(typeof FORK_THEME_FONTS)[number], { readonly kind: Kind }> | undefined {
  if (value === undefined) return undefined;
  for (const family of cssFontFamilies(value)) {
    const font = FORK_THEME_FONTS.find(
      (candidate) =>
        candidate.kind === kind &&
        (candidate.cssFamilies as ReadonlyArray<string>).includes(family),
    );
    if (font) return font as Extract<(typeof FORK_THEME_FONTS)[number], { readonly kind: Kind }>;
  }
  return undefined;
}

function publishedThemeFonts(theme: EnvironmentTheme): PublishedMobileThemeFonts | undefined {
  const sans = bundledFont(theme.fonts?.sans, "sans");
  const code = bundledFont(theme.fonts?.code, "mono");
  const fonts: PublishedMobileThemeFonts = {
    ...(sans
      ? {
          regular: sans.faces.regular.family,
          medium: sans.faces.medium.family,
          bold: sans.faces.bold.family,
        }
      : {}),
    ...(code ? { mono: code.faces.regular.family } : {}),
  };
  return Object.keys(fonts).length > 0 ? fonts : undefined;
}

/**
 * Known limit: the `noise` pattern needs an SVG filter that react-native-svg does not draw, so it
 * keeps the plain canvas. User CSS and icon packs have no React Native form.
 */
function publishedThemeStyle(theme: EnvironmentTheme): PublishedMobileThemeStyle {
  const radius = lengthToPixels(theme.radius);
  // Only a shadow that parses goes into `boxShadow`, rebuilt from its parts.
  const parsedShadow = theme.shadow === undefined ? null : parseThemeShadow(theme.shadow);
  const shadow = parsedShadow
    ? `${parsedShadow.offsetX}px ${parsedShadow.offsetY}px ${parsedShadow.radius}px ${parsedShadow.spread}px ${parsedShadow.color}`
    : undefined;
  const borderWidth = lengthToPixels(theme.borderWidth);
  const fonts = publishedThemeFonts(theme);
  const pattern = theme.canvasPattern;
  return {
    ...(radius !== undefined ? { radius } : {}),
    ...(borderWidth !== undefined ? { borderWidth } : {}),
    ...(shadow ? { shadow } : {}),
    ...(fonts ? { fonts } : {}),
    ...(pattern === "dots" || pattern === "grid"
      ? { canvasPattern: { kind: pattern, color: nativeThemeColor(theme.canvasPatternColor) } }
      : {}),
  };
}

export function toPublishedMobileTheme(theme: EnvironmentTheme): PublishedMobileTheme {
  const colors: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  for (const appearance of ["light", "dark"] as const) {
    const palette = publishedThemeColors(theme, appearance);
    if (palette) colors[appearance] = palette;
  }
  return {
    id: publishedMobileThemeId(theme.id),
    label: theme.name,
    appearances: (["light", "dark"] as const).filter((appearance) => colors[appearance]),
    colors,
    style: publishedThemeStyle(theme),
  };
}

/** What the connected servers say about published themes on mobile. */
export interface PublishedThemeSource {
  /** Null while no server config is loaded, so the app cannot tell yet. */
  readonly enabled: boolean | null;
  /** Live themes of the servers with `mobilePublishedThemes` on. Empty until a server sends them. */
  readonly themes: ReadonlyArray<EnvironmentTheme>;
  readonly defaultTheme: string;
}

/**
 * The machine map syncs `mobilePublishedThemes`, the themes and `defaultTheme` to every server,
 * so the servers normally agree. A theme id that two servers publish keeps the first one.
 */
export function selectPublishedThemeSource(
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
): PublishedThemeSource {
  if (configs.size === 0) {
    return { enabled: null, themes: [], defaultTheme: "" };
  }
  const enabledConfigs = [...configs.values()].filter(
    (config) => config.settings.mobilePublishedThemes,
  );
  const themes = new Map<string, EnvironmentTheme>();
  for (const config of enabledConfigs) {
    for (const theme of config.environmentThemes ?? []) {
      if (!themes.has(theme.id) && isUsablePublishedTheme(theme)) themes.set(theme.id, theme);
    }
  }
  const withDefault = enabledConfigs.find((config) => config.settings.defaultTheme.length > 0);
  return {
    enabled: enabledConfigs.length > 0,
    themes: [...themes.values()],
    defaultTheme: withDefault?.settings.defaultTheme ?? "",
  };
}

/** The stored copy of a theme: the app has no use for user CSS or icon packs. */
export function storedPublishedTheme(theme: EnvironmentTheme): EnvironmentTheme {
  const { css: _css, icons: _icons, ...stored } = theme;
  return stored;
}

/**
 * `ids` with each published theme that the app cannot draw, because no server offers it now or
 * it has no colors for that appearance, replaced by the stock theme. The stored choice stays, so
 * the theme comes back when a server offers it again.
 */
export function availableMobileThemeIds(
  ids: MobileThemeIds,
  themes: ReadonlyArray<PublishedMobileTheme>,
): MobileThemeIds {
  const available = (appearance: ThemeAppearance): MobileThemeId => {
    const id = ids[appearance];
    if (!isPublishedMobileThemeId(id)) return id;
    return themes.some((theme) => theme.id === id && theme.colors[appearance])
      ? id
      : DEFAULT_MOBILE_THEME_ID;
  };
  const light = available("light");
  const dark = available("dark");
  return light === ids.light && dark === ids.dark ? ids : { light, dark };
}

export function publishedThemeStyleOf(
  themeId: MobileThemeId,
  themes: ReadonlyArray<PublishedMobileTheme>,
): PublishedMobileThemeStyle {
  if (!isPublishedMobileThemeId(themeId)) return NO_STYLE;
  return themes.find((theme) => theme.id === themeId)?.style ?? NO_STYLE;
}

/** Every radius token of Tailwind and of `fork-theme.css`, except `full`, which stays round. */
const RADIUS_TOKENS = [
  "--radius",
  "--radius-xs",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl",
  "--radius-2xl",
  "--radius-3xl",
  "--radius-4xl",
  "--radius-3",
  "--radius-7",
  "--radius-10",
  "--radius-11",
  "--radius-12",
  "--radius-14",
  "--radius-16",
  "--radius-18",
  "--radius-20",
  "--radius-22",
  "--radius-24",
  "--radius-26",
  "--radius-28",
] as const;

/**
 * The Uniwind variables of a published theme style. Like web with a theme radius, every radius
 * token becomes the theme radius, so large surfaces do not grow past it.
 */
export function publishedThemeStyleVariables(
  style: PublishedMobileThemeStyle,
): Readonly<Record<`--${string}`, string | number>> {
  const variables: Record<`--${string}`, string | number> = {};
  if (style.radius !== undefined) {
    for (const token of RADIUS_TOKENS) variables[token] = style.radius;
  }
  if (style.borderWidth !== undefined) variables["--theme-border-width"] = style.borderWidth;
  if (style.fonts?.regular) variables["--font-sans"] = style.fonts.regular;
  if (style.fonts?.medium) variables["--font-medium"] = style.fonts.medium;
  if (style.fonts?.bold) variables["--font-bold"] = style.fonts.bold;
  return variables;
}

export interface ParsedThemeShadow {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly radius: number;
  readonly spread: number;
  readonly color: string;
}

/**
 * The first shadow of a CSS `box-shadow` value, for native controls that take numbers, such as
 * the Jetpack Compose `dropShadow` modifier. Null for `inset` or a value that it cannot read.
 */
export function parseThemeShadow(shadow: string): ParsedThemeShadow | null {
  const [first = ""] = shadow.split(/,(?![^(]*\))/);
  const lengths: number[] = [];
  const rest: string[] = [];
  for (const token of first.trim().split(/\s+(?![^(]*\))/)) {
    if (token === "inset") return null;
    const length = token === "0" || token.endsWith("px") ? Number.parseFloat(token) : Number.NaN;
    if (Number.isFinite(length) && rest.length === 0) lengths.push(length);
    else rest.push(token);
  }
  const [offsetX, offsetY, radius = 0, spread = 0] = lengths;
  const color = nativeThemeColor(rest.join(" ") || "#000000");
  if (offsetX === undefined || offsetY === undefined || color === null) return null;
  return { offsetX, offsetY, radius, spread, color };
}

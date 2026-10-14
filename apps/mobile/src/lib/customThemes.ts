import { converter, parse } from "culori";
import {
  BUILT_IN_THEMES,
  MOBILE_DEFAULT_THEME_ID,
  RESERVED_THEME_IDS,
  T3_CHAT_THEME,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
} from "@t3tools/shared/themePalettes";

/** Same schema version the web app reads and writes, so theme files move between clients. */
export const THEME_FILE_VERSION = 1 as const;

/** The on-disk and on-device form of an imported theme. Matches the web's `ThemeFile`. */
export type ThemeFile = Readonly<{
  version: typeof THEME_FILE_VERSION;
  id: string;
  name: string;
  appearance: ThemeAppearance;
  colors: Partial<Record<ThemeColorRole, string>>;
  variants?: Partial<Record<ThemeAppearance, Partial<Record<ThemeColorRole, string>>>>;
}>;

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);
/** Ids a selection may name without an installed custom theme. */
const MOBILE_BUILT_IN_THEME_IDS: ReadonlyArray<string> = [
  MOBILE_DEFAULT_THEME_ID,
  "material-you",
  ...BUILT_IN_THEMES.map((theme) => theme.id),
];
/** Mobile names its own default palette and Material You, so imports may not take those ids. */
const MOBILE_RESERVED_THEME_IDS: ReadonlySet<string> = new Set([
  ...RESERVED_THEME_IDS,
  MOBILE_DEFAULT_THEME_ID,
  "material-you",
]);
const convertToOklch = converter("oklch");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === "light" || value === "dark";
}

function isThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value);
}

function isThemeLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48;
}

function formatOklchNumber(value: number, precision: number): string {
  const rounded = Math.abs(value) < 10 ** -precision / 2 ? 0 : value;
  return rounded.toFixed(precision).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/, "$1");
}

/**
 * Canonicalizes any literal CSS color to the `oklch(...)` form the palettes
 * store, the same normalization the web applies. Returns null for anything
 * that is not a literal color, such as `var(--x)` or `color-mix(...)`.
 */
export function toCanonicalThemeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = parse(value.trim());
  if (!parsed) return null;
  const color = convertToOklch(parsed);
  const lightness = color.l ?? 0;
  const chroma = color.c ?? 0;
  const hue = color.h ?? 0;
  const alpha = color.alpha ?? 1;
  if (![lightness, chroma, hue, alpha].every(Number.isFinite)) return null;
  const normalizedHue = chroma < 0.0000005 ? 0 : ((hue % 360) + 360) % 360;
  const body = `${formatOklchNumber(Math.min(1, Math.max(0, lightness)), 6)} ${formatOklchNumber(Math.max(0, chroma), 6)} ${formatOklchNumber(normalizedHue, 3)}`;
  const clampedAlpha = Math.min(1, Math.max(0, alpha));
  return clampedAlpha < 1
    ? `oklch(${body} / ${formatOklchNumber(clampedAlpha, 4)})`
    : `oklch(${body})`;
}

/** Id derived from a display name, identical to the web's slug rule. */
export function themeIdFromName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "custom-theme";
}

function parseThemeColorOverrides(value: unknown): Partial<Record<ThemeColorRole, string>> {
  if (!isRecord(value)) throw new Error("Theme colors must be objects.");

  const overrides: Partial<Record<ThemeColorRole, string>> = {};
  for (const [role, color] of Object.entries(value)) {
    if (!THEME_COLOR_ROLE_SET.has(role)) {
      throw new Error(`"${role}" is not a supported theme color role.`);
    }
    const normalized = toCanonicalThemeColor(color);
    if (!normalized) {
      throw new Error(
        `The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`,
      );
    }
    overrides[role as ThemeColorRole] = normalized;
  }
  if (Object.keys(overrides).length === 0) {
    throw new Error("Add at least one color role to the theme file.");
  }
  return overrides;
}

/** Missing roles inherit the standard palette, matching the web's fallback. */
function fallbackColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === "dark" ? T3_CHAT_THEME.variants!.dark! : T3_CHAT_THEME.colors;
}

/**
 * Parses a theme file into a palette definition. The format and error messages
 * match the web app's `parseThemeFile`, so a theme exported there imports here.
 */
export function parseThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) {
    throw new Error("Theme files must contain a JSON object.");
  }
  if (value.version !== THEME_FILE_VERSION) {
    throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`);
  }

  const name = value.name;
  const appearance = value.appearance;
  if (!isThemeLabel(name)) throw new Error("Theme files need a name (48 characters or fewer).");
  if (!isThemeAppearance(appearance)) {
    throw new Error('Theme files need an appearance of "light" or "dark".');
  }
  if (!isRecord(value.colors)) throw new Error("Theme files need a colors object.");

  const id = value.id === undefined ? themeIdFromName(name) : value.id;
  if (!isThemeId(id)) {
    throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  }
  if (MOBILE_RESERVED_THEME_IDS.has(id)) {
    throw new Error(`The theme id "${id}" is reserved.`);
  }

  const overrides = parseThemeColorOverrides(value.colors);
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");
    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) {
        throw new Error('Theme variants may only be named "light" or "dark".');
      }
      if (variantAppearance === appearance) {
        throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`);
      }
      variants[variantAppearance] = {
        ...fallbackColors(variantAppearance),
        ...parseThemeColorOverrides(variantColors),
      } as ThemeColors;
    }
  }

  return {
    id,
    label: name.trim(),
    appearance,
    colors: { ...fallbackColors(appearance), ...overrides } as ThemeColors,
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
  };
}

/** The file form of a palette, so it can be persisted and re-imported losslessly. */
export function themeDefinitionToFile(theme: ThemeDefinition): ThemeFile {
  return {
    version: THEME_FILE_VERSION,
    id: theme.id,
    name: theme.label,
    appearance: theme.appearance,
    colors: theme.colors,
    ...(theme.variants ? { variants: theme.variants } : {}),
  };
}

/**
 * Reads persisted custom themes, dropping anything that no longer parses or
 * that repeats an earlier id. Stored values were validated when saved, so this
 * only skips entries written by a different build.
 */
export function parseStoredCustomThemes(value: unknown): ReadonlyArray<ThemeDefinition> {
  if (!Array.isArray(value)) return [];
  const themes: ThemeDefinition[] = [];
  for (const entry of value) {
    try {
      const theme = parseThemeFile(entry);
      if (!themes.some((existing) => existing.id === theme.id)) themes.push(theme);
    } catch {
      // Skip themes this build cannot read; the user can import them again.
    }
  }
  return themes;
}

let customMobileThemes: ReadonlyArray<ThemeDefinition> = [];

/**
 * Publishes the installed custom themes to every palette lookup. Set by the
 * appearance provider before its children render, so a restored selection is
 * never painted with the fallback palette.
 */
export function setCustomMobileThemes(themes: ReadonlyArray<ThemeDefinition>): void {
  customMobileThemes = themes;
}

export function getCustomMobileThemes(): ReadonlyArray<ThemeDefinition> {
  return customMobileThemes;
}

/** Built-in palettes first, then installed custom themes. Null for an unknown id. */
export function findMobileThemeDefinition(themeId: string): ThemeDefinition | null {
  return (
    BUILT_IN_THEMES.find((theme) => theme.id === themeId) ??
    customMobileThemes.find((theme) => theme.id === themeId) ??
    null
  );
}

/** Built-ins may not be shadowed by an imported theme, so this is checked before saving. */
export function isBuiltInThemeId(themeId: string): boolean {
  return BUILT_IN_THEMES.some((theme) => theme.id === themeId);
}

/**
 * Whether a stored theme selection still names an existing palette. Built-in
 * ids always do; a custom id only while its theme is stored, so a selection
 * never outlives the palette it names.
 */
export function isSelectableThemeId(
  value: unknown,
  storedCustomThemes: ReadonlyArray<ThemeDefinition>,
): value is string {
  if (typeof value !== "string") return false;
  return (
    (MOBILE_BUILT_IN_THEME_IDS as readonly string[]).includes(value) ||
    storedCustomThemes.some((theme) => theme.id === value)
  );
}

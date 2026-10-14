import { resolveTextScaleVariables } from "./appearancePreferences";
import { BUILT_IN_THEME_IDS, type BuiltInThemeId } from "@t3tools/shared/themePalettes";
import {
  DEFAULT_MOBILE_THEME_ID,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeMode,
} from "./mobileTheme";

export type MobileUniwindThemeName =
  | MobileThemeAppearance
  | `${BuiltInThemeId}-${MobileThemeAppearance}`;

export interface MobileThemeRuntimeState {
  readonly baseFontSize: number;
  readonly themeAppearance: MobileThemeAppearance;
  readonly themeMode: MobileThemeMode;
}

export type MobileThemeRuntimeOperation =
  | {
      readonly kind: "update-text-variables";
      readonly themeName: "light" | "dark" | MobileUniwindThemeName;
      readonly variables: Readonly<Record<string, number>>;
    }
  | {
      readonly kind: "set-appearance-mode";
      readonly appearance: MobileThemeAppearance;
      readonly themeMode: MobileThemeMode;
    };

const UNIWIND_THEME_NAMES: ReadonlyArray<"light" | "dark" | MobileUniwindThemeName> = [
  "light",
  "dark",
  ...BUILT_IN_THEME_IDS.flatMap((themeId) => [
    `${themeId}-light` as const,
    `${themeId}-dark` as const,
  ]),
];

/**
 * Custom themes have no generated Uniwind variant, so they scope the base
 * appearance theme and carry their palette as runtime variables. See
 * `getMobileThemeRuntimeVariables`.
 */
export function getMobileUniwindThemeName(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): MobileUniwindThemeName {
  return themeId === DEFAULT_MOBILE_THEME_ID ||
    themeId === "material-you" ||
    !isBuiltInUniwindThemeId(themeId)
    ? appearance
    : `${themeId}-${appearance}`;
}

function isBuiltInUniwindThemeId(themeId: string): themeId is BuiltInThemeId {
  return (BUILT_IN_THEME_IDS as readonly string[]).includes(themeId);
}

/**
 * Plans imperative runtime work separately from theme selection. Palette
 * changes are handled by one root ScopedTheme render; only typography and the
 * native appearance override need imperative Uniwind/React Native updates.
 */
export function createMobileThemeRuntimeOperations(
  previous: MobileThemeRuntimeState | null,
  next: MobileThemeRuntimeState,
): ReadonlyArray<MobileThemeRuntimeOperation> {
  const operations: MobileThemeRuntimeOperation[] = [];

  if (previous === null || previous.baseFontSize !== next.baseFontSize) {
    const variables = resolveTextScaleVariables(next.baseFontSize);
    for (const themeName of UNIWIND_THEME_NAMES) {
      operations.push({ kind: "update-text-variables", themeName, variables });
    }
  }

  if (previous === null || previous.themeMode !== next.themeMode) {
    operations.push({
      kind: "set-appearance-mode",
      appearance: next.themeAppearance,
      themeMode: next.themeMode,
    });
  }

  return operations;
}

import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  parseThemeFile,
  serializeThemeFile,
  type ThemeDefinition,
  type ThemeHalves,
  type ThemePreferenceMode,
} from "./themePalette";

/**
 * Client settings that describe how someone likes the client to behave. Values tied to one
 * machine or to one environment's data stay out: onboarding state, dismissed notices, browser
 * profiles, the legacy model preferences and merge overrides, and overrides keyed by project or
 * environment id.
 */
export const DEVICE_SETTINGS_FILE_KEYS = [
  "notificationMode",
  "inAppNotificationsEnabled",
  "diffColorScheme",
  "chatWidth",
  "loadBalancingEnabled",
  "appearanceContrast",
  "panelAnimationDurationMs",
  "browserDefaultViewport",
  "browserDefaultZoomFactor",
  "browserDefaultAppearance",
  "browserRecordingFrameRate",
  "browserRecordingShowKeyPresses",
  "browserRecordingShowMousePresses",
  "browserLinkTarget",
  "browserSearchEngine",
  "browserCustomSearchUrl",
  "browserAutoShowFloatingPreview",
  "confirmQuit",
  "confirmThreadArchive",
  "confirmThreadDelete",
  "confirmThreadUnpin",
  "diffFilesCollapsed",
  "diffIgnoreWhitespace",
  "diffLayout",
  "environmentIdentificationMode",
  "glassOpacity",
  "fontSizeInterface",
  "fontSizePrompt",
  "fontSizeCode",
  "fontSizeTerminal",
  "fontFamilyCode",
  "fontFamilyComposer",
  "fontFamilySans",
  "fontFamilyTerminal",
  "fontSmoothing",
  "persistComposerContextStrip",
  "pullRequestLinksOpenInApp",
  "planModeEnabled",
  "contextWindowMeterEnabled",
  "composerCollapseOnScroll",
  "composerRichTextEnabled",
  "sendShortcut",
  "followUpBehavior",
  "proactivePanelsEnabled",
  "showSkillsInSlashMenu",
  "legacySidebarEnabled",
  "sidebarWorkingShelfEnabled",
  "sidebarProjectGroupingMode",
  "sidebarProjectSortOrder",
  "sidebarThreadSortOrder",
  "sidebarThreadPreviewCount",
  "timestampFormat",
  "snapShotEnabled",
  "snapShotIncludeAccessibility",
  "snapShotShortcut",
  "snapShotPlaySound",
  "snapShotSound",
  "snapShotFlash",
  "snapShotAnimations",
  "wordWrap",
  "mathRenderingEnabled",
] as const satisfies ReadonlyArray<keyof ClientSettings>;

export type DeviceSettingKey = (typeof DEVICE_SETTINGS_FILE_KEYS)[number];
export type DeviceSettings = Pick<ClientSettings, DeviceSettingKey>;

export interface DeviceAppearance {
  readonly theme: string;
  readonly appearanceMode: ThemePreferenceMode;
  readonly themeHalves: ThemeHalves | null;
  readonly advancedTypography: boolean;
}

export const DEFAULT_DEVICE_APPEARANCE: DeviceAppearance = {
  theme: "system",
  appearanceMode: "system",
  themeHalves: null,
  advancedTypography: false,
};

export interface DeviceSettingsSnapshot {
  readonly settings: DeviceSettings;
  readonly appearance: DeviceAppearance;
}

export interface DeviceSettingsFileImport extends DeviceSettingsSnapshot {
  readonly customThemes: ReadonlyArray<ThemeDefinition>;
  readonly warnings: ReadonlyArray<string>;
}

export interface DeviceSettingChange {
  readonly key: string;
  readonly from: unknown;
  readonly to: unknown;
}

const APPEARANCE_FILE_KEYS = new Set([
  "theme",
  "appearanceMode",
  "themeHalves",
  "advancedTypography",
  "customThemes",
]);
const DEVICE_SETTING_KEY_SET: ReadonlySet<string> = new Set(DEVICE_SETTINGS_FILE_KEYS);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeClientSettings = Schema.decodeUnknownOption(ClientSettingsSchema);

function isDeviceSettingKey(key: string): key is DeviceSettingKey {
  return DEVICE_SETTING_KEY_SET.has(key);
}

export function pickDeviceSettings(settings: ClientSettings): DeviceSettings {
  return Object.fromEntries(
    DEVICE_SETTINGS_FILE_KEYS.map((key) => [key, settings[key]]),
  ) as DeviceSettings;
}

function selectedThemeIds(appearance: DeviceAppearance): ReadonlySet<string> {
  return new Set(
    [appearance.theme, appearance.themeHalves?.light, appearance.themeHalves?.dark].filter(
      (themeId) => themeId !== undefined,
    ),
  );
}

/** Only values that differ from their defaults are written, so later default changes still apply. */
export function serializeDeviceSettingsFile(input: {
  readonly settings: ClientSettings;
  readonly appearance: DeviceAppearance;
  readonly customThemes: ReadonlyArray<ThemeDefinition>;
}): string {
  const encoded: Readonly<Record<string, unknown>> = encodeClientSettings(input.settings);
  const file: Record<string, unknown> = {};
  for (const key of DEVICE_SETTINGS_FILE_KEYS) {
    if (!Equal.equals(input.settings[key], DEFAULT_CLIENT_SETTINGS[key])) {
      file[key] = encoded[key];
    }
  }

  const { appearance } = input;
  if (appearance.theme !== DEFAULT_DEVICE_APPEARANCE.theme) file.theme = appearance.theme;
  if (appearance.appearanceMode !== DEFAULT_DEVICE_APPEARANCE.appearanceMode) {
    file.appearanceMode = appearance.appearanceMode;
  }
  if (appearance.themeHalves !== null) file.themeHalves = appearance.themeHalves;
  if (appearance.advancedTypography) file.advancedTypography = true;

  const selected = selectedThemeIds(appearance);
  const customThemes = input.customThemes.filter((theme) => selected.has(theme.id));
  if (customThemes.length > 0) {
    file.customThemes = customThemes.map((theme): unknown => JSON.parse(serializeThemeFile(theme)));
  }

  return `${JSON.stringify(file, null, 2)}\n`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemePreferenceMode(value: unknown): value is ThemePreferenceMode {
  return value === "light" || value === "dark" || value === "system";
}

function readAppearanceValue<T>(
  file: Readonly<Record<string, unknown>>,
  key: string,
  accept: (value: unknown) => value is T,
  fallback: T,
  warnings: string[],
): T {
  if (!(key in file)) return fallback;
  const value = file[key];
  if (accept(value)) return value;
  warnings.push(`${key}: invalid value, reset to its default`);
  return fallback;
}

/**
 * Import replaces every value the file covers: keys the file omits go back to their defaults.
 * Unknown keys and values that fail their schema become warnings instead of failing the file,
 * so a file written by another version still applies everything it can.
 */
export function parseDeviceSettingsFile(
  value: unknown,
  isKnownTheme: (themeId: string) => boolean,
): DeviceSettingsFileImport {
  if (!isRecord(value)) {
    throw new Error("Device settings files must contain a JSON object.");
  }

  const warnings: string[] = [];
  const validSettings: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (APPEARANCE_FILE_KEYS.has(key)) continue;
    if (!isDeviceSettingKey(key)) {
      warnings.push(`${key}: not a device setting, ignored`);
      continue;
    }
    // Decoding the key alone checks it against its own schema; every other key takes its default.
    if (Option.isNone(decodeClientSettings({ [key]: rawValue }))) {
      warnings.push(`${key}: invalid value, reset to its default`);
      continue;
    }
    validSettings[key] = rawValue;
  }
  const settings = pickDeviceSettings(
    Option.getOrElse(decodeClientSettings(validSettings), () => DEFAULT_CLIENT_SETTINGS),
  );

  const customThemes: ThemeDefinition[] = [];
  if ("customThemes" in value) {
    if (Array.isArray(value.customThemes)) {
      value.customThemes.forEach((entry: unknown, index) => {
        try {
          customThemes.push(parseThemeFile(entry));
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : "invalid theme";
          warnings.push(`customThemes[${index}]: ${reason} Ignored.`);
        }
      });
    } else {
      warnings.push("customThemes: expected a list, ignored");
    }
  }

  const isAvailableTheme = (themeId: unknown): themeId is string =>
    typeof themeId === "string" &&
    (isKnownTheme(themeId) || customThemes.some((theme) => theme.id === themeId));
  const isThemeHalves = (halves: unknown): halves is ThemeHalves | null =>
    halves === null ||
    (isRecord(halves) &&
      (halves.light !== undefined || halves.dark !== undefined) &&
      (halves.light === undefined || isAvailableTheme(halves.light)) &&
      (halves.dark === undefined || isAvailableTheme(halves.dark)));
  const isBoolean = (flag: unknown): flag is boolean => typeof flag === "boolean";

  const appearance: DeviceAppearance = {
    theme: readAppearanceValue(
      value,
      "theme",
      isAvailableTheme,
      DEFAULT_DEVICE_APPEARANCE.theme,
      warnings,
    ),
    appearanceMode: readAppearanceValue(
      value,
      "appearanceMode",
      isThemePreferenceMode,
      DEFAULT_DEVICE_APPEARANCE.appearanceMode,
      warnings,
    ),
    themeHalves: readAppearanceValue(
      value,
      "themeHalves",
      isThemeHalves,
      DEFAULT_DEVICE_APPEARANCE.themeHalves,
      warnings,
    ),
    advancedTypography: readAppearanceValue(
      value,
      "advancedTypography",
      isBoolean,
      DEFAULT_DEVICE_APPEARANCE.advancedTypography,
      warnings,
    ),
  };

  return { settings, appearance, customThemes, warnings };
}

export function diffDeviceSettings(
  current: DeviceSettingsSnapshot,
  next: DeviceSettingsSnapshot,
): ReadonlyArray<DeviceSettingChange> {
  const changes: DeviceSettingChange[] = [];
  for (const key of DEVICE_SETTINGS_FILE_KEYS) {
    if (!Equal.equals(current.settings[key], next.settings[key])) {
      changes.push({ key, from: current.settings[key], to: next.settings[key] });
    }
  }
  for (const key of ["theme", "appearanceMode", "themeHalves", "advancedTypography"] as const) {
    if (!Equal.equals(current.appearance[key], next.appearance[key])) {
      changes.push({ key, from: current.appearance[key], to: next.appearance[key] });
    }
  }
  return changes;
}

/** A local theme with the same id is replaced only when its definition differs. */
export function planCustomThemeImport(
  imported: ReadonlyArray<ThemeDefinition>,
  existing: ReadonlyArray<ThemeDefinition>,
): { readonly added: ReadonlyArray<ThemeDefinition>; readonly replaced: ReadonlyArray<ThemeDefinition> } {
  const added: ThemeDefinition[] = [];
  const replaced: ThemeDefinition[] = [];
  for (const theme of imported) {
    const local = existing.find((candidate) => candidate.id === theme.id);
    if (local === undefined) added.push(theme);
    else if (serializeThemeFile(local) !== serializeThemeFile(theme)) replaced.push(theme);
  }
  return { added, replaced };
}

/**
 * Fork: theme sync through the machine map settings (apps/machine-map/SPEC.md, MM-408 to MM-410).
 *
 * Two server settings are not normal settings service fields:
 * - `sharedThemes` is the content of the `themes/` folder. The machine reports the themes it
 *   publishes, and a desired value writes theme files into the folder.
 * - `defaultTheme` changes through the code path of `t3 theme set`, so `defaultThemeSetAt`
 *   updates and connected clients switch.
 */
import {
  type EnvironmentTheme,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  environmentThemeFileHasColors,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { UNPUBLISHABLE_THEME_IDS } from "@t3tools/shared/themePalettes";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolvableThemeIds, writeDefaultTheme } from "../../cli/theme.ts";
import { MAX_THEME_FILE_BYTES } from "../../environmentTheme.ts";

const SHARED_THEMES_KEY = "sharedThemes";
const DEFAULT_THEME_KEY = "defaultTheme";
/** Settings that the map applies here, not through the settings service patch. */
export const THEME_SETTING_KEYS: ReadonlySet<string> = new Set([
  SHARED_THEMES_KEY,
  DEFAULT_THEME_KEY,
]);

/**
 * One theme in `sharedThemes`: the theme file and the `<id>.css` file, or null for no CSS. The
 * shape is the reported shape, so an applied value reads back equal and is no local change.
 */
const SharedTheme = Schema.Struct({
  json: EnvironmentThemeFile,
  css: Schema.NullOr(Schema.String),
});
const decodeSharedThemes = Schema.decodeUnknownExit(Schema.Record(Schema.String, Schema.Unknown));
const decodeSharedTheme = Schema.decodeUnknownExit(SharedTheme);
const isEnvironmentThemeId = Schema.is(EnvironmentThemeId);

/**
 * MM-408: the reported server settings with the published themes as `sharedThemes`.
 * `defaultThemeSetAt` is a set generation, not a value to share, so it is not reported.
 */
export const withSharedThemes = (
  reported: Readonly<Record<string, unknown>>,
  themes: ReadonlyArray<EnvironmentTheme>,
): Readonly<Record<string, unknown>> => {
  const { defaultThemeSetAt: _defaultThemeSetAt, ...rest } = reported;
  return {
    ...rest,
    [SHARED_THEMES_KEY]: Object.fromEntries(
      themes.map(({ id, css, ...json }) => [id, { json, css: css ?? null }]),
    ),
  };
};

/** The reason a theme cannot be written, or null when it can. */
const themeProblem = (id: string, value: unknown) => {
  // The id is the file name: this check also keeps every path inside the folder.
  if (!isEnvironmentThemeId(id) || UNPUBLISHABLE_THEME_IDS.has(id)) {
    return { problem: "not a valid theme id" } as const;
  }
  const decoded = decodeSharedTheme(value);
  if (decoded._tag === "Failure") return { problem: Cause.pretty(decoded.cause) } as const;
  if (!environmentThemeFileHasColors(decoded.value.json)) {
    return { problem: "the theme has no colors" } as const;
  }
  const json = `${JSON.stringify(decoded.value.json, null, 2)}\n`;
  const css = decoded.value.css;
  // The limit of the theme watcher: a larger file would be written and then not published.
  if (
    Buffer.byteLength(json) > MAX_THEME_FILE_BYTES ||
    (css !== null && Buffer.byteLength(css) > MAX_THEME_FILE_BYTES)
  ) {
    return { problem: `a file is larger than ${MAX_THEME_FILE_BYTES} bytes` } as const;
  }
  return { json, css } as const;
};

/** MM-409: writes each changed theme into the folder. Themes not in the value stay. */
const writeSharedThemes = Effect.fn(function* (
  themesDir: string,
  value: unknown,
  current: unknown,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decoded = decodeSharedThemes(value);
  if (decoded._tag === "Failure") {
    return yield* Effect.logWarning("Machine map skipped sharedThemes: it is not an object.");
  }
  const currentThemes = decodeSharedThemes(current);
  const before = currentThemes._tag === "Success" ? currentThemes.value : {};

  for (const [id, theme] of Object.entries(decoded.value)) {
    if (stableStringify(before[id]) === stableStringify(theme)) continue;
    const checked = themeProblem(id, theme);
    if ("problem" in checked) {
      yield* Effect.logWarning("Machine map skipped a shared theme.", {
        themeId: id,
        problem: checked.problem,
      });
      continue;
    }
    const jsonPath = path.join(themesDir, `${id}.json`);
    const cssPath = path.join(themesDir, `${id}.css`);
    // The atomic write follows a symlink, which could point outside the folder.
    const isSymlink = (filePath: string) => fs.readLink(filePath).pipe(Effect.isSuccess);
    if ((yield* isSymlink(jsonPath)) || (yield* isSymlink(cssPath))) {
      yield* Effect.logWarning("Machine map skipped a shared theme.", {
        themeId: id,
        problem: "a theme file is a symlink",
      });
      continue;
    }
    // CSS first: the watcher reads both files again when the theme file changes.
    const write = Effect.gen(function* () {
      if (checked.css === null) {
        if (yield* fs.exists(cssPath)) yield* fs.remove(cssPath);
      } else {
        yield* writeFileStringAtomically({ filePath: cssPath, contents: checked.css });
      }
      yield* writeFileStringAtomically({ filePath: jsonPath, contents: checked.json });
    });
    yield* write.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Machine map could not write a shared theme.", {
          themeId: id,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  }
});

/** MM-410: sets the environment theme like `t3 theme set`. An empty id clears it. */
const applyDefaultTheme = Effect.fn(function* (
  paths: { readonly settingsPath: string; readonly themesDir: string },
  value: unknown,
) {
  if (typeof value !== "string") {
    return yield* Effect.logWarning("Machine map skipped defaultTheme: it is not a string.");
  }
  if (value.length > 0 && !(yield* resolvableThemeIds(paths.themesDir)).includes(value)) {
    return yield* Effect.logWarning("Machine map skipped defaultTheme: no such theme here.", {
      themeId: value,
    });
  }
  yield* writeDefaultTheme({ settingsPath: paths.settingsPath, themeId: value });
});

/**
 * Applies the changed theme settings of a desired state. Themes go first, so a `defaultTheme`
 * that names a shared theme finds its file.
 */
export const applyThemeSettings = Effect.fn(function* (input: {
  readonly settingsPath: string;
  readonly themesDir: string;
  readonly changed: Readonly<Record<string, unknown>>;
  readonly current: Readonly<Record<string, unknown>>;
}) {
  if (Object.hasOwn(input.changed, SHARED_THEMES_KEY)) {
    yield* writeSharedThemes(
      input.themesDir,
      input.changed[SHARED_THEMES_KEY],
      input.current[SHARED_THEMES_KEY],
    );
  }
  if (Object.hasOwn(input.changed, DEFAULT_THEME_KEY)) {
    yield* applyDefaultTheme(input, input.changed[DEFAULT_THEME_KEY]).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Machine map could not set defaultTheme.", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
  }
});

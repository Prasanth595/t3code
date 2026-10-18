import { useAtomValue } from "@effect/atom-react";
import * as Equal from "effect/Equal";
import { Atom } from "effect/reactivity";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";

import {
  selectPublishedThemeSource,
  storedPublishedTheme,
  toPublishedMobileTheme,
  type PublishedMobileTheme,
  type PublishedThemeSource,
} from "../lib/forkPublishedThemes";
import {
  publishedMobileThemeId,
  registerPublishedMobileThemePalettes,
} from "../lib/forkPublishedThemeRegistry";
import { createMobileThemePairPatch, MOBILE_THEME_IDS } from "../lib/mobileTheme";
import type { Preferences } from "../persistence/mobile-preferences";
import { environmentServerConfigsAtom } from "./server";

let previousSource: PublishedThemeSource | null = null;

/** Keeps the previous value while the source is equal, so a reconnect snapshot renders nothing. */
const publishedThemeSourceAtom = Atom.make((get) => {
  const next = selectPublishedThemeSource(get(environmentServerConfigsAtom));
  if (previousSource !== null && Equal.equals(previousSource, next)) return previousSource;
  previousSource = next;
  return next;
}).pipe(Atom.withLabel("mobile:fork-published-theme-source"));

/** The patch that takes the server's `defaultTheme`, or null when it does not resolve yet. */
function defaultThemePatch(
  defaultTheme: string,
  themes: ReadonlyArray<PublishedMobileTheme>,
): Partial<Preferences> | null {
  const published = themes.find((theme) => theme.id === publishedMobileThemeId(defaultTheme));
  if (published) {
    // Each appearance that the theme has colors for. Unlike web, the color scheme mode stays as the
    // user set it, so a light-only default theme does not force light mode on the phone.
    return {
      ...(published.colors.light ? { lightThemeId: published.id } : {}),
      ...(published.colors.dark ? { darkThemeId: published.id } : {}),
    };
  }
  const builtIn = MOBILE_THEME_IDS.find((id) => id === defaultTheme);
  return builtIn ? createMobileThemePairPatch(builtIn) : null;
}

/**
 * Fork: the published themes that the app offers, while a connected server has
 * `mobilePublishedThemes` on. Before a server connects, the stored copy keeps the theme on screen.
 * The hook also stores each new live copy and takes each new `defaultTheme` once.
 *
 * Known limit: an empty live list counts as "not received yet", because the cached server config
 * carries no themes. So when a server stops publishing every theme, the phone keeps the stored
 * copy. Revisit if the server config ever tells a received empty list apart.
 */
export function usePublishedMobileThemes(input: {
  readonly storedPreferences: Preferences | null;
  readonly savePreferences: (patch: Partial<Preferences>) => void;
}): {
  readonly themes: ReadonlyArray<PublishedMobileTheme>;
  /** Grows each time the palette registry changes, so palette lookups by theme id run again. */
  readonly paletteVersion: number;
} {
  const { storedPreferences, savePreferences } = input;
  const source = useAtomValue(publishedThemeSourceAtom);
  const live = source.enabled === true && source.themes.length > 0 ? source.themes : null;
  const raw =
    source.enabled === false ? null : (live ?? storedPreferences?.publishedThemes ?? null);

  const themes = useMemo(() => (raw ?? []).map(toPublishedMobileTheme), [raw]);
  // The registry changes after the render that computed `themes`, and before the paint: the
  // version bump renders again with the new palettes.
  const [paletteVersion, setPaletteVersion] = useState(0);
  useLayoutEffect(() => {
    registerPublishedMobileThemePalettes(new Map(themes.map((theme) => [theme.id, theme.colors])));
    setPaletteVersion((version) => version + 1);
  }, [themes]);

  useEffect(() => {
    if (storedPreferences === null || live === null) return;
    const stored = live.map(storedPublishedTheme);
    if (Equal.equals(stored, storedPreferences.publishedThemes ?? [])) return;
    savePreferences({ publishedThemes: stored });
  }, [live, savePreferences, storedPreferences]);

  useEffect(() => {
    if (storedPreferences === null || source.enabled !== true) return;
    if (source.defaultTheme.length === 0) return;
    // Unlike web, the mark is the theme id alone: `defaultThemeSetAt` is local to each machine, so
    // it differs per server. Known limit: setting the same default theme again does not apply it
    // again on the phone. Revisit if the machine map shares one set time.
    const generation = source.defaultTheme;
    if (storedPreferences.publishedDefaultThemeApplied === generation) return;
    // The setting and the themes arrive apart; an id that does not resolve yet waits for them.
    const patch = defaultThemePatch(source.defaultTheme, themes);
    if (patch === null) return;
    savePreferences({ ...patch, publishedDefaultThemeApplied: generation });
  }, [savePreferences, source, storedPreferences, themes]);

  return { themes, paletteVersion };
}

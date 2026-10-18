/**
 * Fork: the fonts that a published theme can pick on mobile. `app.config.ts` bundles them, and
 * `forkPublishedThemes.ts` maps a theme font family to them. Each native family name is the
 * font's PostScript name, so iOS and Android use the same names.
 *
 * Known limit: a theme font outside this list keeps the stock font. Add a font here when a
 * published theme names one that users want on the phone.
 */
export const FORK_THEME_FONTS = [
  {
    cssFamilies: ["bricolage grotesque"],
    kind: "sans",
    faces: {
      regular: {
        family: "BricolageGrotesque-Regular",
        weight: 400,
        file: "@expo-google-fonts/bricolage-grotesque/400Regular/BricolageGrotesque_400Regular.ttf",
      },
      medium: {
        family: "BricolageGrotesque-Medium",
        weight: 500,
        file: "@expo-google-fonts/bricolage-grotesque/500Medium/BricolageGrotesque_500Medium.ttf",
      },
      bold: {
        family: "BricolageGrotesque-Bold",
        weight: 700,
        file: "@expo-google-fonts/bricolage-grotesque/700Bold/BricolageGrotesque_700Bold.ttf",
      },
    },
  },
  {
    cssFamilies: ["jetbrains mono", "jetbrainsmono nerd font mono", "jetbrainsmono nerd font"],
    kind: "mono",
    faces: {
      regular: {
        family: "JetBrainsMono-Regular",
        weight: 400,
        file: "@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf",
      },
    },
  },
] as const;

type ForkThemeFontFace = {
  readonly family: string;
  readonly weight: number;
  readonly file: string;
};

const FORK_THEME_FONT_FACES: ReadonlyArray<ForkThemeFontFace> = FORK_THEME_FONTS.flatMap((font) =>
  Object.values(font.faces),
);

/** The `expo-font` config plugin entries for the fork theme fonts. */
export const FORK_THEME_FONT_PLUGIN_FILES = {
  ios: FORK_THEME_FONT_FACES.map((face) => face.file),
  android: FORK_THEME_FONT_FACES.map((face) => ({
    fontFamily: face.family,
    fontDefinitions: [{ path: face.file, weight: face.weight }],
  })),
};

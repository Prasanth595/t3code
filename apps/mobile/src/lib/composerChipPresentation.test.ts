import { describe, expect, it } from "vite-plus/test";

import { contextChipAccent, contextChipPresentation } from "./composerChipPresentation";
import { getMobileThemeVariables, MOBILE_THEME_IDS } from "./mobileTheme";

const CHIP_ACCENTS = [
  ...new Set(
    [
      ...[
        "image",
        "video",
        "file",
        "mention",
        "terminal",
        "element",
        "review-comment",
        "pull-request",
        "skill",
        "thread",
      ].map((kind) => contextChipPresentation(kind)),
      ...[
        { state: "open", isDraft: false },
        { state: "open", isDraft: true },
        { state: "merged", isDraft: false },
        { state: "closed", isDraft: false },
      ].map((pullRequest) => contextChipPresentation("pull-request", { pullRequest })),
    ].flatMap(({ accent }) => (accent ? [accent] : [])),
  ),
];

function relativeLuminance(hex: string): number {
  const [red = 0, green = 0, blue = 0] = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const [darker = 0, lighter = 0] = [relativeLuminance(first), relativeLuminance(second)].sort(
    (a, b) => a - b,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

// Chips render on the user bubble and on the thread canvas. Material You is dynamic, so its
// saturated bubble is covered by a representative sample below.
function chipSurfaces(appearance: "light" | "dark") {
  return MOBILE_THEME_IDS.filter((id) => id !== "material-you").flatMap((id) => {
    const theme = getMobileThemeVariables(id, appearance);
    return [
      { surface: theme["--color-user-bubble"], text: theme["--color-user-bubble-foreground"] },
      { surface: theme["--color-thread-canvas"], text: theme["--color-md-body"] },
    ];
  });
}

describe("contextChipAccent", () => {
  it("reads at 4.5:1 on every built-in light theme's user bubble and thread canvas", () => {
    for (const { surface, text } of chipSurfaces("light")) {
      for (const accent of CHIP_ACCENTS) {
        const shown = contextChipAccent(accent, text)!;
        expect(
          contrastRatio(shown, surface),
          `${accent} → ${shown} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the shared accents on dark surfaces and saturated Material You bubbles", () => {
    const surfaces = [...chipSurfaces("dark"), { surface: "#6750A4FF", text: "#FFFFFFFF" }];
    for (const { text } of surfaces) {
      for (const accent of CHIP_ACCENTS) {
        expect(contextChipAccent(accent, text)).toBe(accent);
      }
    }
  });
});

import { describe, expect, it } from "vite-plus/test";

describe("contextChipAccent", () => {
  const presentations = async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    return [
      ...[
        "image",
        "video",
        "file",
        "mention",
        "terminal",
        "element",
        "preview-annotation",
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
    ];
  };

  const luminance = (hex: string) => {
    const [red, green, blue] = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const contrast = (first: string, second: string) => {
    const [darker, lighter] = [luminance(first), luminance(second)].sort((a, b) => a - b);
    return (lighter! + 0.05) / (darker! + 0.05);
  };

  const surfaces = async (appearance: "light" | "dark") => {
    const { getMobileThemeVariables, MOBILE_THEME_IDS } = await import("./mobileTheme");
    return MOBILE_THEME_IDS.filter((id) => id !== "material-you").flatMap((id) => {
      const theme = getMobileThemeVariables(id, appearance);
      return [
        { surface: theme["--color-user-bubble"], text: theme["--color-user-bubble-foreground"] },
        { surface: theme["--color-thread-canvas"], text: theme["--color-md-body"] },
      ];
    });
  };

  it("reads at 4.5:1 on every built-in light theme's user bubble and thread canvas", async () => {
    const { contextChipAccent } = await import("./composerChipPresentation");
    for (const { surface, text } of await surfaces("light")) {
      for (const { accent } of await presentations()) {
        const shown = contextChipAccent(accent, text)!;
        expect(
          contrast(shown, surface),
          `${accent} → ${shown} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the shared accents on dark surfaces", async () => {
    const { contextChipAccent } = await import("./composerChipPresentation");
    const darkSurfaces = [...(await surfaces("dark")), { surface: "#6750A4FF", text: "#FFFFFFFF" }];
    for (const { text } of darkSurfaces) {
      for (const { accent } of await presentations()) {
        expect(contextChipAccent(accent, text)).toBe(accent);
      }
    }
  });
});

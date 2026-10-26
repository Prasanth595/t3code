import { getResolvedOrResolveTheme, registerCustomTheme, type DiffsTheme } from "@pierre/diffs";

/** pierre-light with every syntax color darkened to at least 4.5:1 on white. */
export const READABLE_LIGHT_THEME_NAME = "t3-light";

const MIN_CONTRAST = 4.5;

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function contrastOnWhite(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map(channelLuminance) as [number, number, number];
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

/** Darkens a #rrggbb(aa) color in steps that keep its hue until it reads on white. */
export function readableOnWhite(color: string): string {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (!match) return color;
  let rgb = [0, 2, 4].map((start) => Number.parseInt(match[1]!.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
  if (contrastOnWhite(rgb) >= MIN_CONTRAST) return color;
  while (contrastOnWhite(rgb) < MIN_CONTRAST) {
    rgb = rgb.map((channel) => Math.floor(channel * 0.96)) as [number, number, number];
  }
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}${match[2] ?? ""}`;
}

type ZedTheme = NonNullable<DiffsTheme["zed"]>;

function withReadableSyntax(theme: ZedTheme): ZedTheme {
  const syntax = Object.fromEntries(
    Object.entries(theme.style.syntax ?? {}).map(([scope, style]) => [
      scope,
      typeof style === "string"
        ? readableOnWhite(style)
        : style.color
          ? { ...style, color: readableOnWhite(style.color) }
          : style,
    ]),
  );
  return { ...theme, name: READABLE_LIGHT_THEME_NAME, style: { ...theme.style, syntax } };
}

// Themes resolve on the main thread and reach the diff workers already resolved.
registerCustomTheme(
  READABLE_LIGHT_THEME_NAME,
  async () => {
    const base = await getResolvedOrResolveTheme("pierre-light", "highlights");
    if (!base.zed) throw new Error("pierre-light has no Highlights palette");
    return withReadableSyntax(base.zed);
  },
  "zed",
);

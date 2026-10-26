import { getResolvedOrResolveTheme, registerCustomTheme, type DiffsTheme } from "@pierre/diffs";

/** pierre-light with every syntax color darkened until it reads on every light code surface. */
export const READABLE_LIGHT_THEME_NAME = "t3-light";

const MIN_CONTRAST = 4.5;
// The darkest light code surface is a deleted line's red tint (#fef0f0, luminance 0.897),
// rounded down for margin.
const DARKEST_SURFACE_LUMINANCE = 0.89;

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function contrastOnLightCode(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map(channelLuminance) as [number, number, number];
  return (DARKEST_SURFACE_LUMINANCE + 0.05) / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

/** Darkens a #rrggbb(aa) color in steps that keep its hue until it reads on light code. */
export function readableOnLightCode(color: string, minContrast = MIN_CONTRAST): string {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (!match) return color;
  let rgb = [0, 2, 4].map((start) => Number.parseInt(match[1]!.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
  if (contrastOnLightCode(rgb) >= minContrast) return color;
  while (contrastOnLightCode(rgb) < minContrast) {
    rgb = rgb.map((channel) => Math.floor(channel * 0.96)) as [number, number, number];
  }
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}${match[2] ?? ""}`;
}

type ZedTheme = NonNullable<DiffsTheme["zed"]>;

// Operators share numbers' teal and differ only in lightness, so they go further to stay apart.
const OPERATOR_SCOPES = new Set(["operator", "keyword.operator"]);
const OPERATOR_MIN_CONTRAST = 7;

function withReadableSyntax(theme: ZedTheme): ZedTheme {
  const syntax = Object.fromEntries(
    Object.entries(theme.style.syntax ?? {}).map(([scope, style]) => {
      const minContrast = OPERATOR_SCOPES.has(scope) ? OPERATOR_MIN_CONTRAST : MIN_CONTRAST;
      return [
        scope,
        typeof style === "string"
          ? readableOnLightCode(style, minContrast)
          : style.color
            ? { ...style, color: readableOnLightCode(style.color, minContrast) }
            : style,
      ];
    }),
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

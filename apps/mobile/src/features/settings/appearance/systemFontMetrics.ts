import type { ResolvedMobileCodeSurface } from "../../../lib/appearancePreferences";
import type { NativeReviewDiffStyle } from "../../diffs/nativeReviewDiffSurface";

export function scaleCodeSurfaceMetrics(
  base: ResolvedMobileCodeSurface,
  scaleFont: (size: number) => number,
): ResolvedMobileCodeSurface {
  const fontSize = scaleFont(base.fontSize);
  const lineNumberFontSize = scaleFont(base.lineNumberFontSize);
  return {
    ...base,
    fontSize,
    lineNumberFontSize,
    rowHeight: Math.ceil(base.rowHeight * (fontSize / base.fontSize)),
    gutterWidth: Math.ceil(base.gutterWidth * (lineNumberFontSize / base.lineNumberFontSize)),
  };
}

const FONT_KEYS = [
  "codeFontSize",
  "lineNumberFontSize",
  "hunkFontSize",
  "fileHeaderFontSize",
  "fileHeaderMetaFontSize",
  "fileHeaderSubtextFontSize",
  "fileHeaderStatusFontSize",
  "emptyStateFontSize",
] as const;

export function scaleNativeCodeStyle<Style extends NativeReviewDiffStyle>(
  base: Style,
  scaleFont: (size: number) => number,
): Style {
  const fonts = Object.fromEntries(
    FONT_KEYS.flatMap((key) => (base[key] === undefined ? [] : [[key, scaleFont(base[key])]])),
  ) as Partial<Record<(typeof FONT_KEYS)[number], number>>;
  const ratio = (key: (typeof FONT_KEYS)[number]) =>
    base[key] === undefined ? 1 : scaleFont(base[key]) / base[key];
  const headerRatio = Math.max(ratio("fileHeaderFontSize"), ratio("fileHeaderMetaFontSize"));
  const metric = (value: number | undefined, scale: number) =>
    value === undefined ? undefined : Math.ceil(value * scale);
  return {
    ...base,
    ...fonts,
    rowHeight: metric(base.rowHeight, ratio("codeFontSize")),
    gutterWidth: metric(base.gutterWidth, ratio("lineNumberFontSize")),
    fileHeaderHeight: metric(base.fileHeaderHeight, headerRatio),
    fileHeaderPathRightPadding: metric(base.fileHeaderPathRightPadding, headerRatio),
    fileHeaderCountColumnWidth: metric(base.fileHeaderCountColumnWidth, headerRatio),
  } as Style;
}

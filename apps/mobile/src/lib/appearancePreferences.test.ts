import { describe, expect, it } from "vite-plus/test";

import {
  MAX_CODE_FONT_SIZE,
  resolveAppearancePreferences,
  resolveMobileCodeSurface,
} from "./appearancePreferences";
import { createNativeSourceStyle } from "../features/files/nativeSourceFileAdapter";
import { createNativeReviewDiffStyle } from "../features/review/nativeReviewDiffAdapter";
import {
  scaleCodeSurfaceMetrics,
  scaleNativeCodeStyle,
} from "../features/settings/appearance/systemFontMetrics";

describe("appearancePreferences", () => {
  it("migrates the legacy markdownFontSize key to baseFontSize", () => {
    expect(resolveAppearancePreferences({ markdownFontSize: 18 }).baseFontSize).toBe(18);
    expect(
      resolveAppearancePreferences({ baseFontSize: 16, markdownFontSize: 18 }).baseFontSize,
    ).toBe(16);
  });

  it("keeps accessibility scaling beyond preference bounds and native row geometry in sync", () => {
    const base = resolveMobileCodeSurface(MAX_CODE_FONT_SIZE);
    const scale = (size: number) => size * 3.2;
    const metrics = scaleCodeSurfaceMetrics(base, scale);
    const source = scaleNativeCodeStyle(createNativeSourceStyle(base), scale);
    const review = scaleNativeCodeStyle(createNativeReviewDiffStyle(base, true), scale);

    expect(metrics.fontSize).toBe(MAX_CODE_FONT_SIZE * 3.2);
    expect(source.codeFontSize).toBe(metrics.fontSize);
    expect(review.codeFontSize).toBe(metrics.fontSize);
    expect(source.rowHeight).toBe(metrics.rowHeight);
    expect(review.rowHeight).toBe(metrics.rowHeight);
    expect(source.gutterWidth).toBe(metrics.gutterWidth);
    expect(review.gutterWidth).toBe(metrics.gutterWidth);
    expect(metrics.rowHeight).toBeGreaterThan(metrics.fontSize);
    expect(base.fontSize).toBe(MAX_CODE_FONT_SIZE);
  });

  it("converts different font sizes independently when the system curve is nonlinear", () => {
    const base = resolveMobileCodeSurface(MAX_CODE_FONT_SIZE);
    const style = createNativeReviewDiffStyle(base, false);
    const convert = (size: number) => (size <= 14 ? size * 2 : size + 14);
    const scaled = scaleNativeCodeStyle(style, convert);

    expect(scaled.codeFontSize).toBe(convert(style.codeFontSize));
    expect(scaled.hunkFontSize).toBe(convert(style.hunkFontSize));
    expect(scaled.fileHeaderMetaFontSize).toBe(convert(style.fileHeaderMetaFontSize));
    expect(scaled.fileHeaderMetaFontSize / style.fileHeaderMetaFontSize).not.toBe(
      scaled.codeFontSize / style.codeFontSize,
    );
    expect(scaled.codePadding).toBe(style.codePadding);
    expect(scaled.fileHeaderHorizontalMargin).toBe(style.fileHeaderHorizontalMargin);
    expect(scaleNativeCodeStyle(style, (size) => size)).toEqual(style);
  });
});

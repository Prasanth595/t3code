import { DEFAULT_TERMINAL_LINE_HEIGHT } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { measureGhosttyCell, resolveTerminalLineHeight, terminalGridSize } from "./renderer";

function measuringContext(metrics: {
  readonly ascent: number;
  readonly descent: number;
  readonly width?: number;
}): CanvasRenderingContext2D {
  return {
    font: "",
    measureText: () => ({
      width: metrics.width ?? 8,
      actualBoundingBoxAscent: metrics.ascent,
      actualBoundingBoxDescent: metrics.descent,
    }),
  } as unknown as CanvasRenderingContext2D;
}

describe("measureGhosttyCell", () => {
  const fontSize = 12;
  const shortGlyph = measuringContext({ ascent: 8, descent: 2 });
  const tallGlyph = measuringContext({ ascent: 14, descent: 5 });

  it("keeps the historical row pitch when line height is omitted", () => {
    const omitted = measureGhosttyCell(shortGlyph, fontSize, "monospace");
    const explicit = measureGhosttyCell(
      shortGlyph,
      fontSize,
      "monospace",
      DEFAULT_TERMINAL_LINE_HEIGHT,
    );
    expect(DEFAULT_TERMINAL_LINE_HEIGHT).toBe(1.35);
    expect(omitted).toEqual(explicit);
    expect(omitted.height).toBe(Math.max(1, Math.round(fontSize * 1.35), 10));
  });

  it("scales row height with the multiplier and refuses to clip the glyph", () => {
    const tight = measureGhosttyCell(shortGlyph, fontSize, "monospace", 1);
    const comfortable = measureGhosttyCell(shortGlyph, fontSize, "monospace", 1.2);
    const loose = measureGhosttyCell(shortGlyph, fontSize, "monospace", 2);
    expect(tight.height).toBe(Math.round(fontSize * 1));
    expect(comfortable.height).toBe(Math.round(fontSize * 1.2));
    expect(loose.height).toBe(Math.round(fontSize * 2));
    expect(tight.height).toBeLessThan(comfortable.height);
    expect(comfortable.height).toBeLessThan(
      measureGhosttyCell(shortGlyph, fontSize, "monospace", 1.35).height,
    );
    expect(loose.height).toBeGreaterThan(
      measureGhosttyCell(shortGlyph, fontSize, "monospace").height,
    );

    const glyphHeight = 19;
    const clamped = measureGhosttyCell(tallGlyph, fontSize, "monospace", 1);
    expect(Math.round(fontSize * 1)).toBeLessThan(glyphHeight);
    expect(clamped.height).toBe(glyphHeight);
    expect(clamped.baseline - 14).toBeGreaterThanOrEqual(0);
    expect(clamped.baseline + 5).toBeLessThanOrEqual(clamped.height);
  });

  it("clamps out-of-range pitches before measuring", () => {
    expect(resolveTerminalLineHeight(undefined)).toBe(1.35);
    expect(resolveTerminalLineHeight(Number.NaN)).toBe(1.35);
    expect(resolveTerminalLineHeight(0.25)).toBe(1);
    expect(resolveTerminalLineHeight(4)).toBe(2);
    const below = measureGhosttyCell(shortGlyph, fontSize, "monospace", 0.25);
    const above = measureGhosttyCell(shortGlyph, fontSize, "monospace", 4);
    expect(below.height).toBe(measureGhosttyCell(shortGlyph, fontSize, "monospace", 1).height);
    expect(above.height).toBe(measureGhosttyCell(shortGlyph, fontSize, "monospace", 2).height);
  });

  it("fits fewer rows as the line height grows", () => {
    const padding = 4;
    const tight = measureGhosttyCell(shortGlyph, fontSize, "monospace", 1);
    const loose = measureGhosttyCell(shortGlyph, fontSize, "monospace", 2);
    expect(terminalGridSize(120, 80, loose, padding).rows).toBeLessThan(
      terminalGridSize(120, 80, tight, padding).rows,
    );
    expect(terminalGridSize(120, 80, tight, padding).cols).toBe(
      terminalGridSize(120, 80, loose, padding).cols,
    );
  });
});

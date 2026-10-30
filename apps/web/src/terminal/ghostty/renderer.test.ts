import { describe, expect, it } from "vite-plus/test";

import { measureGhosttyCell, resolveTerminalCellHeightAdjust, terminalGridSize } from "./renderer";

function measuringContext(metrics: {
  readonly fontAscent: number;
  readonly fontDescent: number;
  readonly inkAscent: number;
  readonly inkDescent: number;
  readonly width?: number;
}): CanvasRenderingContext2D {
  return {
    font: "",
    measureText: () => ({
      width: metrics.width ?? 8,
      fontBoundingBoxAscent: metrics.fontAscent,
      fontBoundingBoxDescent: metrics.fontDescent,
      actualBoundingBoxAscent: metrics.inkAscent,
      actualBoundingBoxDescent: metrics.inkDescent,
    }),
  } as unknown as CanvasRenderingContext2D;
}

describe("measureGhosttyCell", () => {
  const fontSize = 13;
  // DejaVu Sans Mono at 13px: font box 12+3=15, which rounds to Ghostty's cell.
  const dejavu = measuringContext({
    fontAscent: 12,
    fontDescent: 3,
    inkAscent: 9,
    inkDescent: 3,
  });

  it("uses the font box at 0% and grows it by a percentage", () => {
    const natural = measureGhosttyCell(dejavu, fontSize, "DejaVu Sans Mono");
    const explicit = measureGhosttyCell(dejavu, fontSize, "DejaVu Sans Mono", 0);
    expect(natural).toEqual(explicit);
    expect(natural.height).toBe(15);
    expect(measureGhosttyCell(dejavu, fontSize, "DejaVu Sans Mono", 10).height).toBe(
      Math.round(15 * 1.1),
    );
    expect(measureGhosttyCell(dejavu, fontSize, "DejaVu Sans Mono", 20).height).toBe(18);
    expect(18).toBe(Math.round(fontSize * 1.35));
  });

  it.each([
    { fontAscent: 12, fontDescent: 3, inkAscent: 9, inkDescent: 3 },
    { fontAscent: 9.6, fontDescent: 2.4, inkAscent: 9.6, inkDescent: 2.4 },
    { fontAscent: 10, fontDescent: 2, inkAscent: 12.1, inkDescent: 3 },
  ])("keeps font and glyph bounds inside a reduced row: %j", (metrics) => {
    const clamped = measureGhosttyCell(measuringContext(metrics), fontSize, "monospace", -50);
    expect(clamped.height).toBeGreaterThanOrEqual(metrics.fontAscent + metrics.fontDescent);
    expect(clamped.height).toBeGreaterThanOrEqual(metrics.inkAscent + metrics.inkDescent);
    expect(clamped.baseline - metrics.inkAscent).toBeGreaterThanOrEqual(0);
    expect(clamped.baseline + metrics.inkDescent).toBeLessThanOrEqual(clamped.height);
  });

  it("clamps out-of-range percentages before measuring", () => {
    expect(resolveTerminalCellHeightAdjust(undefined)).toBe(0);
    expect(resolveTerminalCellHeightAdjust(Number.NaN)).toBe(0);
    expect(resolveTerminalCellHeightAdjust(-80)).toBe(-50);
    expect(resolveTerminalCellHeightAdjust(140)).toBe(100);
    expect(measureGhosttyCell(dejavu, fontSize, "DejaVu Sans Mono", -80).height).toBe(
      measureGhosttyCell(dejavu, fontSize, "DejaVu Sans Mono", -50).height,
    );
    expect(measureGhosttyCell(dejavu, fontSize, "DejaVu Sans Mono", 140).height).toBe(
      measureGhosttyCell(dejavu, fontSize, "DejaVu Sans Mono", 100).height,
    );
  });

  it("fits fewer rows as the cell grows", () => {
    const padding = 4;
    const natural = measureGhosttyCell(dejavu, fontSize, "DejaVu Sans Mono", 0);
    const loose = measureGhosttyCell(dejavu, fontSize, "DejaVu Sans Mono", 20);
    expect(terminalGridSize(120, 72, loose, padding).rows).toBeLessThan(
      terminalGridSize(120, 72, natural, padding).rows,
    );
    expect(terminalGridSize(120, 72, natural, padding).cols).toBe(
      terminalGridSize(120, 72, loose, padding).cols,
    );
  });
});

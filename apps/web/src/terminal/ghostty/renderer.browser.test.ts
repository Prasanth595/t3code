import { describe, expect, it } from "vite-plus/test";

import type { GhosttyCell, GhosttySnapshot } from "./core";
import { renderGhosttySnapshot } from "./renderer";

const background = { r: 255, g: 255, b: 255 };

const blank: GhosttyCell = {
  text: "",
  wide: 0,
  foreground: { r: 0, g: 0, b: 0 },
  background,
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
};

/** Counts device pixels that are not the terminal background. */
function pixelsOffBackground(context: CanvasRenderingContext2D): number {
  const { data } = context.getImageData(0, 0, context.canvas.width, context.canvas.height);
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] !== 255 || data[index + 1] !== 255 || data[index + 2] !== 255) count += 1;
  }
  return count;
}

describe.each([1.25, 2.2])("renderGhosttySnapshot at a %sx device pixel ratio", (scale) => {
  it.each([
    ["bar", 0],
    ["block", 1],
    ["underline", 2],
    ["hollow block", 3],
  ])("erases a %s cursor completely when it blinks off", (_name, cursorStyle) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(40 * scale);
    canvas.height = Math.round(60 * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas unavailable");
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const snapshot: GhosttySnapshot = {
      cols: 3,
      rows: 3,
      foreground: { r: 0, g: 0, b: 0 },
      background,
      cursor: { r: 0, g: 0, b: 0 },
      cursorX: 1,
      cursorY: 1,
      cursorVisible: true,
      cursorBlinking: true,
      cursorStyle,
      dirtyRows: new Set(),
      rowData: [0, 1, 2].map(() => ({
        cells: [blank, blank, blank],
        text: "",
        isWrapContinuation: false,
        wrapsToNext: false,
      })),
    };
    const options = {
      context,
      snapshot,
      metrics: { width: 8, height: 17, baseline: 13 },
      fontSize: 13,
      fontFamily: "monospace",
      padding: 4,
      originY: 4,
    };

    renderGhosttySnapshot({ ...options, forceFull: true, cursorOn: true });
    expect(pixelsOffBackground(context)).toBeGreaterThan(0);

    renderGhosttySnapshot({ ...options, forceFull: false, cursorOn: false, previousCursorY: 1 });
    expect(pixelsOffBackground(context)).toBe(0);
  });
});

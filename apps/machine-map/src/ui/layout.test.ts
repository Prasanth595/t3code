import { describe, expect, it } from "vite-plus/test";

import { placePairs, separate, type Box } from "./layout.ts";

const overlaps = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

const anyOverlap = (boxes: ReadonlyArray<Box>) =>
  boxes.some((a, i) => boxes.some((b, j) => i < j && overlaps(a, b)));

const card = (x: number, y: number): Box => ({ x, y, w: 224, h: 110 });

describe("separate (MM-1103)", () => {
  it("leaves cards that do not overlap where they are", () => {
    const boxes = [card(200, 200), card(700, 200), card(450, 600)];
    expect(separate(boxes, 1200, 800)).toEqual(boxes);
  });

  it("pulls apart cards on the same spot and keeps them inside the map", () => {
    const out = separate([card(300, 300), card(300, 300), card(310, 305)], 1200, 800);
    expect(anyOverlap(out)).toBe(false);
    for (const box of out) {
      expect(box.x - box.w / 2).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w / 2).toBeLessThanOrEqual(1200);
    }
  });

  it("fits four cards on a phone map, where saved positions crowd together", () => {
    const phone = (x: number, y: number): Box => ({ x, y, w: 156, h: 96 });
    const out = separate(
      [phone(180, 80), phone(270, 470), phone(78, 270), phone(282, 200)],
      360,
      560,
    );
    expect(anyOverlap(out)).toBe(false);
  });

  it("moves only the cards that are not fixed", () => {
    const fixed = card(400, 300);
    const out = separate([fixed, card(420, 310)], 1200, 800, new Set([0]));
    expect(out[0]).toEqual(fixed);
    expect(overlaps(out[0] ?? fixed, out[1] ?? fixed)).toBe(false);
  });
});

describe("placePairs (MM-1103)", () => {
  it("puts a pair card in the middle of its line when the middle is free", () => {
    const [spot] = placePairs(
      [{ a: { x: 100, y: 400 }, b: { x: 1100, y: 400 }, w: 300, h: 90 }],
      [card(100, 400), card(1100, 400)],
      1200,
      800,
    );
    expect(spot).toEqual({ x: 600, y: 400 });
  });

  it("keeps two crossing pair cards apart and off the machine cards", () => {
    // A square: both diagonals cross in the middle.
    const machines = [card(200, 150), card(1000, 150), card(1000, 650), card(200, 650)];
    const size = { w: 300, h: 90 };
    const spots = placePairs(
      [
        { a: { x: 200, y: 150 }, b: { x: 1000, y: 650 }, ...size },
        { a: { x: 1000, y: 150 }, b: { x: 200, y: 650 }, ...size },
      ],
      machines,
      1200,
      800,
    );
    const pairBoxes = spots.map((p) => ({ ...p, ...size }));
    expect(anyOverlap(pairBoxes)).toBe(false);
    for (const pair of pairBoxes)
      for (const machine of machines) expect(overlaps(pair, machine)).toBe(false);
  });

  it("moves a pair card beside a short line between two stacked machines", () => {
    const machines = [card(600, 200), card(600, 340)];
    const size = { w: 300, h: 90 };
    const [spot] = placePairs(
      [{ a: { x: 600, y: 200 }, b: { x: 600, y: 340 }, ...size }],
      machines,
      1200,
      800,
    );
    const pair = { ...(spot ?? { x: 0, y: 0 }), ...size };
    for (const machine of machines) expect(overlaps(pair, machine)).toBe(false);
  });
});

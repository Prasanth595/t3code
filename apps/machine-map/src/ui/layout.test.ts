import { describe, expect, it } from "vite-plus/test";

import {
  anyInView,
  fitView,
  MAX_ZOOM,
  offsetPoint,
  pairCurve,
  pairPath,
  placePairs,
  pointOffset,
  separate,
  toMapPoint,
  toScreenPoint,
  zoomAt,
  type Box,
  type Point,
} from "./layout.ts";

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
      [{ a: { x: 100, y: 400 }, b: { x: 1100, y: 400 }, w: 300, h: 90, fixed: null }],
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
        { a: { x: 200, y: 150 }, b: { x: 1000, y: 650 }, ...size, fixed: null },
        { a: { x: 1000, y: 150 }, b: { x: 200, y: 650 }, ...size, fixed: null },
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
      [{ a: { x: 600, y: 200 }, b: { x: 600, y: 340 }, ...size, fixed: null }],
      machines,
      1200,
      800,
    );
    const pair = { ...(spot ?? { x: 0, y: 0 }), ...size };
    for (const machine of machines) expect(overlaps(pair, machine)).toBe(false);
  });
});

describe("pair placement (MM-1108)", () => {
  const a = { x: 100, y: 100 };
  const b = { x: 100, y: 500 };

  it("turns a dropped point into an offset and back", () => {
    const point = { x: 160, y: 200 };
    const offset = pointOffset(a, b, point, 800);
    expect(offset.along).toBeCloseTo(0.25);
    expect(offsetPoint(a, b, offset, 800).x).toBeCloseTo(point.x, 0);
    expect(offsetPoint(a, b, offset, 800).y).toBeCloseTo(point.y, 0);
  });

  it("follows the machines: the card keeps its place relative to the line", () => {
    const offset = pointOffset(a, b, { x: 100, y: 300 }, 800);
    // Both machines move right by 400: the card moves with them.
    expect(offsetPoint({ x: 500, y: 100 }, { x: 500, y: 500 }, offset, 800)).toEqual({
      x: 500,
      y: 300,
    });
  });

  it("keeps the offset in range for a point past the ends", () => {
    expect(pointOffset(a, b, { x: 100, y: 900 }, 800).along).toBe(1);
    expect(pointOffset(a, b, { x: 5000, y: 300 }, 800).aside).toBe(-1);
  });

  it("keeps a fixed card where the owner put it, and moves automatic cards off it", () => {
    const size = { w: 200, h: 80 };
    const line = { a: { x: 100, y: 400 }, b: { x: 1100, y: 400 } };
    const [fixed, auto] = placePairs(
      [
        { ...line, ...size, fixed: { x: 600, y: 400 } },
        { ...line, ...size, fixed: null },
      ],
      [],
      1200,
      800,
    );
    expect(fixed).toEqual({ x: 600, y: 400 });
    expect(overlaps({ ...(auto ?? { x: 0, y: 0 }), ...size }, { x: 600, y: 400, ...size })).toBe(
      false,
    );
  });

  it("shows a fixed card beside a machine card that it covers", () => {
    const size = { w: 200, h: 80 };
    const machine = card(600, 400);
    const [fixed] = placePairs(
      [{ a: { x: 100, y: 400 }, b: { x: 1100, y: 400 }, ...size, fixed: { x: 600, y: 400 } }],
      [machine],
      1200,
      800,
    );
    expect(overlaps({ ...(fixed ?? { x: 0, y: 0 }), ...size }, machine)).toBe(false);
  });
});

describe("zoom and pan (MM-1116)", () => {
  it("keeps the point under the pointer, stops at the limits, and fits every card", () => {
    const view = zoomAt({ x: 40, y: 10, k: 1 }, { x: 300, y: 200 }, 1.5);
    expect(toScreenPoint(view, toMapPoint({ x: 40, y: 10, k: 1 }, { x: 300, y: 200 }))).toEqual({
      x: 300,
      y: 200,
    });
    expect(zoomAt(view, { x: 0, y: 0 }, 100).k).toBe(MAX_ZOOM);
    const fitted = fitView([card(100, 100), card(2000, 900)], 800, 600);
    expect(fitted && anyInView(fitted, [card(2000, 900)], 800, 600)).toBe(true);
    expect(fitView([], 800, 600)).toBeNull();
  });
});

describe("pairCurve (MM-1108)", () => {
  const a = { x: 100, y: 100 };
  const b = { x: 700, y: 100 };
  /** Twice the area of the triangle: zero when the three points are on one line. */
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

  it("starts at A, passes the card and ends at B", () => {
    const p = { x: 300, y: 260 };
    const curve = pairCurve(a, b, p);
    expect(curve[0]).toEqual(a);
    expect(curve[3]).toEqual(p);
    expect(curve[6]).toEqual(b);
  });

  it("bends smoothly through the card, without a corner", () => {
    const curve = pairCurve(a, b, { x: 300, y: 260 });
    const [, , before, p, after] = curve;
    if (!before || !p || !after) throw new Error("short curve");
    expect(cross(before, p, after)).toBeCloseTo(0);
    // Both controls point along A -> B, on opposite sides of the card.
    expect(before.x).toBeLessThan(p.x);
    expect(after.x).toBeGreaterThan(p.x);
  });

  it("stays straight for a card on the line", () => {
    for (const q of pairCurve(a, b, { x: 250, y: 100 })) expect(q.y).toBeCloseTo(100);
  });

  it("keeps an automatic card on a straight line", () => {
    expect(pairPath(a, b, null)).toBe("M100,100L700,100");
  });
});

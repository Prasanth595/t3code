import type { PairOffset } from "@t3tools/contracts/machineMap";

/**
 * Pixel layout of the map (MM-1103). Saved positions can overlap, for example on a narrow phone
 * map or for machines that joined close together. The page shows them apart and does not save
 * the result, so every page keeps the same saved map.
 */

/** A card by its center and size, in pixels. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The space between two cards. */
export const GAP = 14;
/** Rounds of pushing. A few machines settle in fewer; more rounds only cost time. */
const ROUNDS = 60;

const clampBox = (box: Box, width: number, height: number): Box => ({
  ...box,
  x: Math.min(Math.max(box.x, box.w / 2), Math.max(box.w / 2, width - box.w / 2)),
  y: Math.min(Math.max(box.y, box.h / 2), Math.max(box.h / 2, height - box.h / 2)),
});

/**
 * Pushes overlapping boxes apart inside `width` x `height`. Boxes in `fixed` do not move.
 * Each push takes the axis that needs the shorter move and still fits, so a box at the edge
 * moves the other way. When the area is too small, boxes stay as close to apart as it allows.
 */
export function separate(
  boxes: ReadonlyArray<Box>,
  width: number,
  height: number,
  fixed: ReadonlySet<number> = new Set(),
): Array<Box> {
  const out = boxes.map((box, i) => (fixed.has(i) ? box : clampBox(box, width, height)));
  for (let round = 0; round < ROUNDS; round++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        if (!a || !b || (fixed.has(i) && fixed.has(j))) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = (a.w + b.w) / 2 + GAP - Math.abs(dx);
        const overlapY = (a.h + b.h) / 2 + GAP - Math.abs(dy);
        if (overlapX <= 0.5 || overlapY <= 0.5) continue;
        const shareA = fixed.has(i) ? 0 : fixed.has(j) ? 1 : 0.5;
        const shareB = 1 - shareA;
        // Identical centers split by their order, so the result never depends on chance.
        const signX = dx === 0 ? 1 : Math.sign(dx);
        const signY = dy === 0 ? 1 : Math.sign(dy);
        const alongX = (box: Box, share: number, sign: number) =>
          clampBox({ ...box, x: box.x + sign * overlapX * share }, width, height);
        const alongY = (box: Box, share: number, sign: number) =>
          clampBox({ ...box, y: box.y + sign * overlapY * share }, width, height);
        const xMove = [alongX(a, shareA, -signX), alongX(b, shareB, signX)] as const;
        const yMove = [alongY(a, shareA, -signY), alongY(b, shareB, signY)] as const;
        // How much of the overlap each axis removes after the edges stop it.
        const xGain = Math.abs(xMove[1].x - xMove[0].x) - Math.abs(dx);
        const yGain = Math.abs(yMove[1].y - yMove[0].y) - Math.abs(dy);
        const xFits = xGain >= overlapX - 0.5;
        const yFits = yGain >= overlapY - 0.5;
        const useX = xFits && yFits ? overlapX <= overlapY : xFits || (!yFits && xGain >= yGain);
        const [nextA, nextB] = useX ? xMove : yMove;
        if (
          Math.abs(nextA.x - a.x) +
            Math.abs(nextA.y - a.y) +
            Math.abs(nextB.x - b.x) +
            Math.abs(nextB.y - b.y) <
          0.5
        )
          continue;
        out[i] = nextA;
        out[j] = nextB;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

const overlapArea = (a: Box, b: Box): number => {
  const x = Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
  const y = Math.min(a.y + a.h / 2, b.y + b.h / 2) - Math.max(a.y - a.h / 2, b.y - b.h / 2);
  return x > 0 && y > 0 ? x * y : 0;
};

/** Places along the line, from the middle out. */
const ALONG = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74];
/**
 * Then beside the line, in widths of the card across the line, so a short line between two
 * stacked machines still finds a spot next to them.
 */
const ASIDE = [0, 0.5, -0.5, 1, -1, 1.5, -1.5];
/** A pair card on a machine card costs more than a pair card on a pair card. */
const MACHINE_WEIGHT = 4;

/** The unit normal of the line from `a` to `b`. A line of no length points down. */
function normal(a: Point, b: Point): Point {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length === 0) return { x: 0, y: 1 };
  return { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** MM-1108: the center of a pair card from its offset. `scale` is the shorter side of the map. */
export function offsetPoint(a: Point, b: Point, offset: PairOffset, scale: number): Point {
  const n = normal(a, b);
  return {
    x: a.x + (b.x - a.x) * offset.along + n.x * offset.aside * scale,
    y: a.y + (b.y - a.y) * offset.along + n.y * offset.aside * scale,
  };
}

/** MM-1108: the offset of a pair card center, the inverse of `offsetPoint`, kept in range. */
export function pointOffset(a: Point, b: Point, p: Point, scale: number): PairOffset {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const n = normal(a, b);
  const along = lengthSquared === 0 ? 0.5 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  const aside = scale === 0 ? 0 : ((p.x - a.x) * n.x + (p.y - a.y) * n.y) / scale;
  // Four decimals is under a pixel on any screen, and keeps the map small.
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return { along: round(clamp(along, 0, 1)), aside: round(clamp(aside, -1, 1)) };
}

/**
 * Places each pair card on its line. A card with a `fixed` center (MM-1108) stays there, unless
 * it covers a machine card or a note, for example on a narrower map than the one that placed it.
 * Then it moves the shortest way off them. Each other card takes the first spot that covers no
 * machine card, no note and no pair card placed before it. Without a free spot, it takes the spot
 * that covers the least. A second push for that card can move it onto a machine card, so it
 * stays; the owner can drag it. Revisit when crowded maps on desktop show stacked pair cards.
 */
export function placePairs(
  pairs: ReadonlyArray<{
    readonly a: Point;
    readonly b: Point;
    readonly w: number;
    readonly h: number;
    readonly fixed: Point | null;
  }>,
  machines: ReadonlyArray<Box>,
  width: number,
  height: number,
  notes: ReadonlyArray<Box> = [],
): Array<Point> {
  const pad = (box: Box): Box => ({ ...box, w: box.w + GAP, h: box.h + GAP });
  const padded = machines.map(pad);
  const cards = [...machines, ...notes];
  const keepOff = (box: Box): Box =>
    separate([...cards, box], width, height, new Set(cards.keys()))[cards.length] ?? box;
  // Cards that the owner placed go first, so automatic cards keep off them.
  const fixedBoxes = pairs.map(({ fixed, w, h }) =>
    fixed ? keepOff(clampBox({ ...fixed, w, h }, width, height)) : null,
  );
  const placed: Array<Box> = [
    ...notes.map(pad),
    ...fixedBoxes.flatMap((box) => (box ? [pad(box)] : [])),
  ];
  return pairs.map(({ a, b, w, h }, i) => {
    const fixedBox = fixedBoxes[i];
    if (fixedBox) return { x: fixedBox.x, y: fixedBox.y };
    const { x: nx, y: ny } = normal(a, b);
    // How wide the card is along the normal.
    const across = Math.abs(nx) * w + Math.abs(ny) * h;
    let best: { box: Box; score: number } | null = null;
    for (const aside of ASIDE) {
      for (const t of ALONG) {
        const box = clampBox(
          {
            x: a.x + (b.x - a.x) * t + nx * aside * across,
            y: a.y + (b.y - a.y) * t + ny * aside * across,
            w,
            h,
          },
          width,
          height,
        );
        const near = pad(box);
        const score =
          padded.reduce((sum, m) => sum + MACHINE_WEIGHT * overlapArea(near, m), 0) +
          placed.reduce((sum, p) => sum + overlapArea(near, p), 0);
        if (best === null || score < best.score) best = { box, score };
        if (score === 0) break;
      }
      if (best?.score === 0) break;
    }
    const box = best?.box ?? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w, h };
    placed.push(pad(box));
    return { x: box.x, y: box.y };
  });
}

/**
 * MM-1108: the line of a pair through its placed card, as two cubic curves A -> P -> B. The curve
 * passes P in the direction from A to B, so it bends smoothly through the card. The card covers
 * the middle, so the line shows to enter and leave at the card edges. P on the straight line gives
 * a straight curve. Returns A, two controls, P, two controls, B.
 */
export function pairCurve(a: Point, b: Point, p: Point): ReadonlyArray<Point> {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const u = length === 0 ? { x: 0, y: 0 } : { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const toP = Math.hypot(p.x - a.x, p.y - a.y) / 3;
  const fromP = Math.hypot(b.x - p.x, b.y - p.y) / 3;
  return [
    a,
    { x: a.x + (p.x - a.x) / 3, y: a.y + (p.y - a.y) / 3 },
    { x: p.x - u.x * toP, y: p.y - u.y * toP },
    p,
    { x: p.x + u.x * fromP, y: p.y + u.y * fromP },
    { x: b.x + (p.x - b.x) / 3, y: b.y + (p.y - b.y) / 3 },
    b,
  ];
}

/** MM-1108: the SVG path of a pair line. A card in its automatic place (`through` null) keeps it straight. */
export function pairPath(a: Point, b: Point, through: Point | null): string {
  if (through === null) return `M${a.x},${a.y}L${b.x},${b.y}`;
  const [start, ...rest] = pairCurve(a, b, through).map((q) => `${q.x},${q.y}`);
  return `M${start}C${rest.slice(0, 3).join(" ")}C${rest.slice(3).join(" ")}`;
}

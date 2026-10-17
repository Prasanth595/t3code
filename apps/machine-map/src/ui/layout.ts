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
const GAP = 14;
/** Rounds of pushing. A few machines settle in fewer; more rounds only cost time. */
const ROUNDS = 60;

/**
 * Pushes overlapping boxes apart. Boxes in `fixed` do not move. Each push takes the axis that
 * needs the shorter move. The map has no edges (MM-1114), so every push fits.
 */
export function separate(
  boxes: ReadonlyArray<Box>,
  fixed: ReadonlySet<number> = new Set(),
): Array<Box> {
  const out = [...boxes];
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
        // Identical centers split by their order, so the result never depends on chance.
        const useX = overlapX <= overlapY;
        const sign = useX ? (dx === 0 ? 1 : Math.sign(dx)) : dy === 0 ? 1 : Math.sign(dy);
        const push = (box: Box, by: number): Box =>
          useX ? { ...box, x: box.x + by * overlapX } : { ...box, y: box.y + by * overlapY };
        out[i] = push(a, -sign * shareA);
        out[j] = push(b, sign * (1 - shareA));
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

/** MM-1108: the center of a pair card from its offset, in map pixels. */
export function offsetPoint(a: Point, b: Point, offset: PairOffset): Point {
  const n = normal(a, b);
  return {
    x: a.x + (b.x - a.x) * offset.along + n.x * offset.aside,
    y: a.y + (b.y - a.y) * offset.along + n.y * offset.aside,
  };
}

/** MM-1108: the offset of a pair card center, the inverse of `offsetPoint`, along the line kept in range. */
export function pointOffset(a: Point, b: Point, p: Point): PairOffset {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const n = normal(a, b);
  const along = lengthSquared === 0 ? 0.5 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  const aside = (p.x - a.x) * n.x + (p.y - a.y) * n.y;
  // Four decimals is under a pixel on any screen, and keeps the map small.
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return { along: round(clamp(along, 0, 1)), aside: round(aside) };
}

/**
 * Places each pair card on its line. A card with a `fixed` center (MM-1108) stays there, unless
 * it covers a machine card or a note, for example after a card grew. Then it moves the shortest way off them. Each other card takes the first spot that covers no
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
  notes: ReadonlyArray<Box> = [],
): Array<Point> {
  const pad = (box: Box): Box => ({ ...box, w: box.w + GAP, h: box.h + GAP });
  const padded = machines.map(pad);
  const cards = [...machines, ...notes];
  const keepOff = (box: Box): Box =>
    separate([...cards, box], new Set(cards.keys()))[cards.length] ?? box;
  // Cards that the owner placed go first, so automatic cards keep off them.
  const fixedBoxes = pairs.map(({ fixed, w, h }) => (fixed ? keepOff({ ...fixed, w, h }) : null));
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
        const box = {
          x: a.x + (b.x - a.x) * t + nx * aside * across,
          y: a.y + (b.y - a.y) * t + ny * aside * across,
          w,
          h,
        };
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

/**
 * MM-1116: the view of the map on one device. The map layer moves by `x` and `y` screen pixels
 * and scales by `k`: a map point `p` shows at `p * k + (x, y)`.
 */
export interface MapViewport {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

/** MM-1116: the zoom limits. The map has no edges, so "Fit" can need a far zoom out. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;
export const clampZoom = (k: number) => clamp(k, MIN_ZOOM, MAX_ZOOM);

export const toMapPoint = (view: MapViewport, screen: Point): Point => ({
  x: (screen.x - view.x) / view.k,
  y: (screen.y - view.y) / view.k,
});

export const toScreenPoint = (view: MapViewport, point: Point): Point => ({
  x: point.x * view.k + view.x,
  y: point.y * view.k + view.y,
});

/** Zooms by `factor`. The map point under the screen point `at` stays under it. */
export function zoomAt(view: MapViewport, at: Point, factor: number): MapViewport {
  const k = clampZoom(view.k * factor);
  const p = toMapPoint(view, at);
  return { k, x: at.x - p.x * k, y: at.y - p.y * k };
}

/** The margin around the cards after "Fit", in screen pixels. */
const FIT_MARGIN = 24;

/**
 * MM-1116 "Fit": every box shows inside a `width` x `height` screen, centered, at most at 100%.
 * Null without boxes.
 */
export function fitView(
  boxes: ReadonlyArray<Box>,
  width: number,
  height: number,
): MapViewport | null {
  if (boxes.length === 0 || width <= 0 || height <= 0) return null;
  const left = Math.min(...boxes.map((b) => b.x - b.w / 2));
  const right = Math.max(...boxes.map((b) => b.x + b.w / 2));
  const top = Math.min(...boxes.map((b) => b.y - b.h / 2));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h / 2));
  const k = clampZoom(
    Math.min(
      1,
      (width - 2 * FIT_MARGIN) / Math.max(1, right - left),
      (height - 2 * FIT_MARGIN) / Math.max(1, bottom - top),
    ),
  );
  return { k, x: width / 2 - ((left + right) / 2) * k, y: height / 2 - ((top + bottom) / 2) * k };
}

/** Whether at least one box shows, in part, on a `width` x `height` screen. */
export function anyInView(
  view: MapViewport,
  boxes: ReadonlyArray<Box>,
  width: number,
  height: number,
): boolean {
  return boxes.some((b) => {
    const a = toScreenPoint(view, { x: b.x - b.w / 2, y: b.y - b.h / 2 });
    const z = toScreenPoint(view, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
    return a.x < width && z.x > 0 && a.y < height && z.y > 0;
  });
}

/**
 * MM-1121: a card that "Auto layout" places, by its center and size. A card with `between` is a
 * pair card: it stays in the middle of the line between those two cards.
 */
export interface LayoutCard extends Box {
  readonly id: string;
  readonly between?: readonly [string, string];
}

/** MM-1121: an arrow between two cards and the length its line wants, center to center. */
export interface LayoutLink {
  readonly a: string;
  readonly b: string;
  readonly length: number;
}

/** Rounds of the force layout. Its moves shrink each round, so the end is calm. */
const LAYOUT_ROUNDS = 400;
/** The largest move of a card in the first round, in map pixels. */
const LAYOUT_FIRST_STEP = 80;
/** Room between two cards, on top of their sizes. Closer cards push apart. */
const LAYOUT_ROOM = 50;
/** How hard closer cards push apart, and how hard a line pulls toward its length. */
const LAYOUT_PUSH = 0.5;
const LAYOUT_PULL = 0.2;
/**
 * How hard every card falls toward the middle. `settle` splits it by the shape of the view, so
 * the layout comes out wide on a desktop and tall on a phone.
 */
const LAYOUT_GRAVITY = 0.04;
/** Starts that the layout tries besides the current places. Each start costs one more run. */
const LAYOUT_STARTS = 12;
/** A fresh start must make the lines this much shorter to replace a start with as few faults. */
const LAYOUT_BETTER = 0.9;
/** The space between the cards and the notes, and between two notes. */
const NOTE_MARGIN = 60;
const NOTE_GAP = 30;

/** A small fixed pseudo-random sequence (mulberry32), so the same map gives the same layout. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** True when the segments `a`–`b` and `c`–`d` cross. Touching ends do not count. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/** True when the segment `a`–`b` passes through `box` (Liang–Barsky clipping). */
function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let low = 0;
  let high = 1;
  const edges: Array<readonly [number, number]> = [
    [-dx, a.x - (box.x - box.w / 2)],
    [dx, box.x + box.w / 2 - a.x],
    [-dy, a.y - (box.y - box.h / 2)],
    [dy, box.y + box.h / 2 - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) low = Math.max(low, t);
    else high = Math.min(high, t);
    if (low > high) return false;
  }
  return true;
}

type Rider = readonly [card: number, a: number, b: number];

const middleOf = (at: ReadonlyArray<Point>, i: number, j: number): Point => {
  const a = at[i] ?? { x: 0, y: 0 };
  const b = at[j] ?? a;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

/**
 * Moves the cards from `start` with the forces, then removes every overlap. A rider takes no
 * step of its own: the push on it goes half to each end, and it stays in the middle of its line.
 */
function settle(
  cards: ReadonlyArray<LayoutCard>,
  links: ReadonlyArray<readonly [number, number, number]>,
  riders: ReadonlyArray<Rider>,
  start: ReadonlyArray<Point>,
  shape: number,
): Array<Box> {
  const gravityX = LAYOUT_GRAVITY / shape;
  const gravityY = LAYOUT_GRAVITY * shape;
  const riding = new Set(riders.map(([card]) => card));
  const at = [...start];
  for (const [card, a, b] of riders) at[card] = middleOf(at, a, b);
  for (let round = 0; round < LAYOUT_ROUNDS; round++) {
    const step = LAYOUT_FIRST_STEP * (1 - round / LAYOUT_ROUNDS) + 1;
    const push = at.map(() => ({ x: 0, y: 0 }));
    const middle = {
      x: at.reduce((sum, p) => sum + p.x, 0) / Math.max(1, at.length),
      y: at.reduce((sum, p) => sum + p.y, 0) / Math.max(1, at.length),
    };
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i];
        const b = cards[j];
        const pa = at[i];
        const pb = at[j];
        const fa = push[i];
        const fb = push[j];
        if (!a || !b || !pa || !pb || !fa || !fb) continue;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const room = Math.max(a.w + b.w, a.h + b.h) / 2 + LAYOUT_ROOM;
        if (distance >= room) continue;
        const force = (room - distance) * LAYOUT_PUSH;
        fa.x -= (dx / distance) * force;
        fa.y -= (dy / distance) * force;
        fb.x += (dx / distance) * force;
        fb.y += (dy / distance) * force;
      }
    }
    for (const [i, j, length] of links) {
      const pa = at[i];
      const pb = at[j];
      const fa = push[i];
      const fb = push[j];
      if (!pa || !pb || !fa || !fb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - length) * LAYOUT_PULL;
      fa.x += (dx / distance) * force;
      fa.y += (dy / distance) * force;
      fb.x -= (dx / distance) * force;
      fb.y -= (dy / distance) * force;
    }
    for (const [card, a, b] of riders) {
      const f = push[card];
      const fa = push[a];
      const fb = push[b];
      if (!f || !fa || !fb) continue;
      fa.x += f.x / 2;
      fa.y += f.y / 2;
      fb.x += f.x / 2;
      fb.y += f.y / 2;
    }
    for (const [i, p] of at.entries()) {
      const f = push[i];
      if (!f || riding.has(i)) continue;
      const fx = f.x + (middle.x - p.x) * gravityX;
      const fy = f.y + (middle.y - p.y) * gravityY;
      const size = Math.hypot(fx, fy);
      const scale = size > step ? step / size : 1;
      at[i] = { x: p.x + fx * scale, y: p.y + fy * scale };
    }
    for (const [card, a, b] of riders) at[card] = middleOf(at, a, b);
  }
  return separate(cards.map((card, i) => ({ ...card, ...(at[i] ?? card) })));
}

/**
 * Line crossings plus lines through a card that is neither an end nor the pair card of the line,
 * and the length of the lines.
 */
function judge(
  boxes: ReadonlyArray<Box>,
  links: ReadonlyArray<readonly [number, number, number]>,
  riders: ReadonlyArray<Rider>,
): { readonly faults: number; readonly length: number } {
  const own = (k: number, i: number, j: number) =>
    riders.some(([card, a, b]) => card === k && ((a === i && b === j) || (a === j && b === i)));
  let faults = 0;
  let length = 0;
  for (const [n, [i, j]] of links.entries()) {
    const a = boxes[i];
    const b = boxes[j];
    if (!a || !b) continue;
    length += Math.hypot(b.x - a.x, b.y - a.y);
    for (const [k, box] of boxes.entries()) {
      if (k !== i && k !== j && !own(k, i, j) && segmentHitsBox(a, b, box)) faults++;
    }
    for (const [k, l] of links.slice(n + 1)) {
      const c = boxes[k];
      const d = boxes[l];
      if (!c || !d || k === i || k === j || l === i || l === j) continue;
      if (segmentsCross(a, b, c, d)) faults++;
    }
  }
  return { faults, length };
}

/**
 * MM-1121 "Auto layout": a small force layout. Each line pulls its two cards toward its length,
 * two cards closer than their room push apart, and a pull toward the middle keeps the map
 * compact. `separate` then removes every overlap. A pair card rides in the middle of its line, so
 * the layout keeps that spot free for it. The layout runs from the current places and from a few
 * fixed pseudo-random starts. It keeps the result with the fewest line crossings and lines through
 * cards, then the shortest lines. The current places win a tie, so a map that reads well keeps its
 * shape. Notes link to nothing, so they go beside the cards, where they cover no line. The result
 * is centered on `center` and has about the `shape` (width by height) of the view.
 *
 * Limit: the starts are a sample, not a search, so a dense map can keep a crossing that a
 * layered layout would remove. Revisit when maps grow past about 20 machines or the owner sees
 * crossings after "Auto layout": then use a layered layout library such as elkjs.
 */
export function autoLayout(
  cards: ReadonlyArray<LayoutCard>,
  links: ReadonlyArray<LayoutLink>,
  notes: ReadonlyArray<Box>,
  center: Point,
  shape: number,
): { readonly cards: Array<Point>; readonly notes: Array<Point> } {
  // A view with no size yet counts as square.
  const ratio = Number.isFinite(shape) && shape > 0 ? shape : 1;
  const index = new Map(cards.map((card, i) => [card.id, i]));
  const pairs = links.flatMap((link): Array<readonly [number, number, number]> => {
    const i = index.get(link.a);
    const j = index.get(link.b);
    return i === undefined || j === undefined || i === j ? [] : [[i, j, link.length]];
  });
  const riders = cards.flatMap((card, i): Array<Rider> => {
    if (!card.between) return [];
    const a = index.get(card.between[0]);
    const b = index.get(card.between[1]);
    return a === undefined || b === undefined || a === b ? [] : [[i, a, b]];
  });
  const random = sequence(1);
  const spreadX = 300 * Math.sqrt(cards.length * ratio);
  const spreadY = 300 * Math.sqrt(cards.length / ratio);
  const starts: Array<Array<Point>> = [
    // Cards on the same spot start a little apart, by their order.
    cards.map((card, i) => ({ x: card.x + i * 0.5, y: card.y + i * 0.5 })),
    ...Array.from({ length: LAYOUT_STARTS }, () =>
      cards.map(() => ({ x: random() * spreadX, y: random() * spreadY })),
    ),
  ];
  // The current places come first and win every tie, so a second click changes nothing.
  const current = cards.map((card, i): Box => {
    const rider = riders.find(([r]) => r === i);
    return rider ? { ...card, ...middleOf(cards, rider[1], rider[2]) } : card;
  });
  const candidates = [
    separate(current),
    ...starts.map((start) => settle(cards, pairs, riders, start, ratio)),
  ];
  let best: {
    readonly boxes: Array<Box>;
    readonly faults: number;
    readonly length: number;
  } | null = null;
  for (const boxes of candidates) {
    const { faults, length } = judge(boxes, pairs, riders);
    if (
      !best ||
      faults < best.faults ||
      (faults === best.faults && length < best.length * LAYOUT_BETTER)
    )
      best = { boxes, faults, length };
  }
  const placed = best?.boxes ?? [];
  // Notes go in a column right of the cards on a wide view, and in a row below them on a tall one.
  const wide = ratio >= 1;
  const edge = (pick: (b: Box) => number) =>
    placed.length === 0 ? 0 : Math.max(...placed.map(pick)) + NOTE_MARGIN;
  const first = (pick: (b: Box) => number) =>
    placed.length === 0 ? 0 : Math.min(...placed.map(pick));
  const line = wide ? edge((b) => b.x + b.w / 2) : edge((b) => b.y + b.h / 2);
  let next = wide ? first((b) => b.y - b.h / 2) : first((b) => b.x - b.w / 2);
  const noteBoxes = notes.map((note): Box => {
    const box = wide
      ? { ...note, x: line + note.w / 2, y: next + note.h / 2 }
      : { ...note, x: next + note.w / 2, y: line + note.h / 2 };
    next += (wide ? note.h : note.w) + NOTE_GAP;
    return box;
  });
  // Everything moves so the whole layout is centered on `center`.
  const all = [...placed, ...noteBoxes];
  if (all.length === 0) return { cards: [], notes: [] };
  const middleX =
    (Math.min(...all.map((b) => b.x - b.w / 2)) + Math.max(...all.map((b) => b.x + b.w / 2))) / 2;
  const middleY =
    (Math.min(...all.map((b) => b.y - b.h / 2)) + Math.max(...all.map((b) => b.y + b.h / 2))) / 2;
  const shift = (b: Box): Point => ({ x: b.x + center.x - middleX, y: b.y + center.y - middleY });
  return { cards: placed.map(shift), notes: noteBoxes.map(shift) };
}

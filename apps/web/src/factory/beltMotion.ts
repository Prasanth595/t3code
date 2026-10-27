import { useState } from "react";

import { holdBins, placesOf, tileMotions, type Belt, type Place, type TileMotion } from "./belt";

/** How long a slide takes; the transition on `.factory-ghost` in belt.css says the same. */
const SLIDE_MS = 750;
/** How big a tile is when it lands in a bin. */
const BIN_SCALE = "scale(.55)";

interface Seen {
  readonly places: ReadonlyMap<string, Place> | null;
  /** What changed in the latest read of the belt: played once, after the commit that shows it. */
  readonly motions: ReadonlyArray<TileMotion>;
  /** The runs still sliding into a bin: the bin does not count them yet. */
  readonly landing: ReadonlySet<string>;
}

const FIRST_READ: Seen = { places: null, motions: [], landing: new Set() };

/** A tile that left the DOM in this commit: where it was, and what it looked like. */
interface Departed {
  readonly rect: DOMRect;
  readonly node: HTMLElement;
}

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const samePlaces = (a: ReadonlyMap<string, Place>, b: ReadonlyMap<string, Place>) =>
  a.size === b.size && Array.from(a).every(([key, place]) => b.get(key) === place);

/** Plays `cls`, a one-shot animation of belt.css, from its start, and drops it when it ends. */
function oneShot(element: Element | null | undefined, cls: string) {
  if (!(element instanceof HTMLElement)) return;
  element.classList.remove(cls);
  // Reading the layout restarts an animation the class had already played.
  void element.offsetWidth;
  element.classList.add(cls);
  const end = (event: Event) => {
    // An animation of a child bubbles up here and is not this one's end.
    if (event.target !== element) return;
    element.classList.remove(cls);
    element.removeEventListener("animationend", end);
  };
  element.addEventListener("animationend", end);
}

/**
 * Flies a copy of `source` in `layer`, from where it was to the box `last`, and calls `onLand`
 * once, when the transform ends (or is cancelled, or does not run at all). The copy is no link and
 * is hidden from assistive tech: the real tile is the one to find.
 */
function fly(
  layer: HTMLElement,
  source: Departed,
  last: { readonly left: number; readonly top: number },
  end: { readonly transform: string; readonly opacity?: string },
  onLand: () => void,
) {
  const { rect, node } = source;
  const origin = layer.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = `${node.className} factory-ghost`;
  if (node.dataset.station !== undefined) ghost.dataset.station = node.dataset.station;
  ghost.setAttribute("aria-hidden", "true");
  for (const child of node.childNodes) ghost.append(child.cloneNode(true));
  // It sits at its final box and starts displaced back to where it was: the FLIP "invert".
  ghost.style.left = `${last.left - origin.left}px`;
  ghost.style.top = `${last.top - origin.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.transform = `translate(${rect.left - last.left}px, ${rect.top - last.top}px)`;
  layer.append(ghost);
  // Style the start before the end is set, or the browser takes the end for the start.
  void ghost.getBoundingClientRect();
  ghost.style.transform = end.transform;
  if (end.opacity !== undefined) ghost.style.opacity = end.opacity;

  let landed = false;
  const land = () => {
    if (landed) return;
    landed = true;
    clearTimeout(fallback);
    ghost.remove();
    onLand();
  };
  ghost.addEventListener("transitionend", (event) => {
    if (event.propertyName === "transform") land();
  });
  ghost.addEventListener("transitioncancel", land);
  // A slide with nowhere to go (or a hidden tab) fires no transition event.
  const fallback = setTimeout(land, SLIDE_MS + 250);
}

/**
 * What the motion keeps between renders, outside React's state. A tile that changes post changes
 * lane, so React removes its element and mounts another: `tileRef` sees the one go and the other
 * come, and `play` flies a copy between them, since the lanes clip what they hold.
 */
function createMotion() {
  const tiles = new Map<string, HTMLElement>();
  const departed = new Map<string, Departed>();
  // Where every tile was when the commit removed its first one, by key.
  const before = new Map<string, DOMRect>();
  let played: ReadonlyArray<TileMotion> | null = null;

  /** On every tile, with its run's key in `data-tile`. */
  const tileRef = (node: HTMLElement | null) => {
    const key = node?.dataset.tile;
    if (node === null || key === undefined) return;
    tiles.set(key, node);
    return () => {
      if (tiles.get(key) !== node) return;
      // React runs this while the element is still in the page. The first removal of a commit
      // measures every tile, as a lane closes up behind each tile it loses.
      if (before.size === 0) {
        for (const [tileKey, tile] of tiles) before.set(tileKey, tile.getBoundingClientRect());
        // Such places are good for the commit they were taken in, not for a later move.
        queueMicrotask(() => {
          before.clear();
          departed.clear();
        });
      }
      tiles.delete(key);
      departed.set(key, { rect: before.get(key) ?? node.getBoundingClientRect(), node });
    };
  };

  /** Plays `motions` in `layer`, once every tile of their commit is in place. */
  const play = (
    layer: HTMLElement,
    motions: ReadonlyArray<TileMotion>,
    landed: (keys: ReadonlyArray<string>) => void,
  ) => {
    const root = layer.parentElement;
    // Each read plays once, however often the layer's ref is set again.
    if (root === null || motions === played) return;
    played = motions;
    const find = (selector: string) => root.querySelector(selector);
    const immediate: Array<string> = [];
    for (const motion of motions) {
      const tile = tiles.get(motion.key);
      const from = departed.get(motion.key);
      if (motion.kind === "enter") {
        oneShot(tile, "factory-tile-enter");
      } else if (motion.kind === "slide") {
        // A tile folded into a lane's `+N` has no element to fly from or to.
        if (tile === undefined || from === undefined) continue;
        tile.style.visibility = "hidden";
        fly(layer, from, tile.getBoundingClientRect(), { transform: "" }, () => {
          tile.style.visibility = "";
          oneShot(tile, "factory-tile-glow");
          oneShot(find(`[data-post="${motion.to}"]`), "factory-post-flash");
        });
      } else {
        const bin = find(`[data-bin="${motion.to}"]`);
        if (bin === null || from === undefined) {
          immediate.push(motion.key);
          continue;
        }
        const box = bin.getBoundingClientRect();
        const last = {
          left: box.left + (box.width - from.rect.width) / 2,
          top: box.top + (box.height - from.rect.height) / 2,
        };
        fly(layer, from, last, { transform: BIN_SCALE, opacity: "0" }, () => {
          landed([motion.key]);
          oneShot(find(`[data-post="${motion.to}"]`), "factory-post-flash");
        });
      }
    }
    if (immediate.length > 0) landed(immediate);
  };

  return { tileRef, play };
}

/**
 * Motion for the belt's tiles, from the belt as each poll derives it. Draw `shown`, put `tileRef` on
 * every tile (the run's key in `data-tile`) and `layerRef` on an empty last child of the element
 * holding the tiles and bins. `live` is false until the belt has a first read; that one, and
 * `prefers-reduced-motion`, move nothing.
 */
export function useBeltMotion(belt: Belt, live: boolean) {
  const [motion] = useState(createMotion);
  const [seen, setSeen] = useState(FIRST_READ);

  if (live) {
    const places = placesOf(belt);
    if (seen.places === null || !samePlaces(seen.places, places)) {
      const motions = reducedMotion() ? [] : tileMotions(seen.places, places);
      const landing = new Set(seen.landing);
      for (const { kind, key } of motions) if (kind === "leave") landing.add(key);
      setSeen({ places, motions, landing });
    }
  }

  // Last child of the belt, so it is set after every tile ref of the commit that shows the motions.
  const layerRef = (layer: HTMLDivElement | null) => {
    if (layer === null) return;
    motion.play(layer, seen.motions, (keys) =>
      setSeen((current) => {
        const landing = new Set(current.landing);
        for (const key of keys) landing.delete(key);
        return { ...current, landing };
      }),
    );
  };

  return { shown: holdBins(belt, seen.landing), tileRef: motion.tileRef, layerRef };
}

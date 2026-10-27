import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { holdBins, placesOf, tileMotions, type Belt, type Place, type TileMotion } from "./belt";

/** How long a slide takes; belt.css has the rest of the transition of `.factory-ghost`. */
const SLIDE_MS = 750;
/** How long a run that left its lane waits, as a ghost where it stood, for a bin to list it. */
const PARK_MS = 5000;
/** How big a tile is when it lands in a bin. */
const BIN_SCALE = "scale(.55)";

interface Seen {
  readonly places: ReadonlyMap<string, Place> | null;
  /** The environment of each run of the belt, by key: where a run that left a lane is read again. */
  readonly environments: ReadonlyMap<string, EnvironmentId>;
  /** What changed in the latest read of the belt: played once, after the commit that shows it. */
  readonly motions: ReadonlyArray<TileMotion>;
  /** The environments whose recent runs list is read again, for the runs that exited. */
  readonly refresh: ReadonlyArray<EnvironmentId>;
  /** The runs still sliding into a bin: the bin does not count them yet. */
  readonly landing: ReadonlySet<string>;
}

const FIRST_READ: Seen = {
  places: null,
  environments: new Map(),
  motions: [],
  refresh: [],
  landing: new Set(),
};

/** A tile that left the DOM in this commit: where it was, and what it looked like. */
interface Departed {
  readonly rect: DOMRect;
  readonly node: HTMLElement;
}

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const environmentsOf = (belt: Belt): ReadonlyMap<string, EnvironmentId> => {
  const environments = new Map<string, EnvironmentId>();
  for (const runs of [...Object.values(belt.runs), belt.stuck, belt.info]) {
    for (const run of runs) environments.set(run.key, run.environmentId);
  }
  return environments;
};

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

/** Where a ghost sits in the layer, and how big it is. */
interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A copy of `node` in `layer` at `box` (a rect in the page), for a tile that has left the page. It
 * is no link and is hidden from assistive tech: the real tile is the one to find. belt.css makes it
 * transition its transform and opacity; this sets how long.
 */
function ghostOf(layer: HTMLElement, node: HTMLElement, box: Box) {
  const origin = layer.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = `${node.className} factory-ghost`;
  if (node.dataset.station !== undefined) ghost.dataset.station = node.dataset.station;
  ghost.setAttribute("aria-hidden", "true");
  for (const child of node.childNodes) ghost.append(child.cloneNode(true));
  ghost.style.left = `${box.left - origin.left}px`;
  ghost.style.top = `${box.top - origin.top}px`;
  ghost.style.width = `${box.width}px`;
  ghost.style.height = `${box.height}px`;
  ghost.style.transitionDuration = `${SLIDE_MS}ms`;
  layer.append(ghost);
  return ghost;
}

/**
 * Flies a copy of `source` in `layer`, from where it was to the box `last`, and calls `onLand`
 * once, when the transform ends (or is cancelled, or does not run at all).
 */
function fly(
  layer: HTMLElement,
  source: Departed,
  last: { readonly left: number; readonly top: number },
  end: { readonly transform: string; readonly opacity?: string },
  onLand: () => void,
) {
  const { rect, node } = source;
  // `last` may be a DOMRect, whose getters a spread does not copy.
  const ghost = ghostOf(layer, node, {
    left: last.left,
    top: last.top,
    width: rect.width,
    height: rect.height,
  });
  // It sits at its final box and starts displaced back to where it was: the FLIP "invert".
  ghost.style.transform = `translate(${rect.left - last.left}px, ${rect.top - last.top}px)`;
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

/** A tile that left its lane for no place, standing as a ghost where it was until a bin lists it. */
interface Parked {
  readonly ghost: HTMLElement;
  readonly node: HTMLElement;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Fades `ghost` out where it stands, then removes it. */
function fadeAway(ghost: HTMLElement) {
  ghost.style.opacity = "0";
  const remove = () => {
    clearTimeout(fallback);
    ghost.remove();
  };
  ghost.addEventListener("transitionend", (event) => {
    if (event.propertyName === "opacity") remove();
  });
  ghost.addEventListener("transitioncancel", remove);
  const fallback = setTimeout(remove, SLIDE_MS + 250);
}

/**
 * What the motion keeps between renders, outside React's state. A tile that changes post is
 * removed and mounted again: `tileRef` sees it go and `play` flies a copy to where it lands, since
 * the lanes clip what they hold. A tile that leaves for no place waits as a copy (parked).
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

  const parked = new Map<string, Parked>();

  /** Takes a parked tile's ghost out of the page: where it stands now, and what it copied. */
  const unpark = (key: string): Departed | undefined => {
    const entry = parked.get(key);
    if (entry === undefined) return undefined;
    parked.delete(key);
    clearTimeout(entry.timer);
    // Measured as it is now: the page may have scrolled since it was parked.
    const rect = entry.ghost.getBoundingClientRect();
    entry.ghost.remove();
    return { rect, node: entry.node };
  };

  /** Plays `motions` in `layer`, once every tile of their commit is in place. */
  const play = (
    layer: HTMLElement,
    motions: ReadonlyArray<TileMotion>,
    refresh: ReadonlyArray<EnvironmentId>,
    refreshRecent: (environmentId: EnvironmentId) => void,
    landed: (keys: ReadonlyArray<string>) => void,
  ) => {
    const root = layer.parentElement;
    // Each read plays once, however often the layer's ref is set again.
    if (root === null || motions === played) return;
    played = motions;
    const find = (selector: string) => root.querySelector(selector);
    const slide = (tile: HTMLElement, from: Departed, to: Place) => {
      tile.style.visibility = "hidden";
      fly(layer, from, tile.getBoundingClientRect(), { transform: "" }, () => {
        tile.style.visibility = "";
        oneShot(tile, "factory-tile-glow");
        oneShot(find(`[data-post="${to}"]`), "factory-post-flash");
      });
    };
    // The status read has dropped runs that no bin lists yet: read the lists that would.
    for (const environmentId of refresh) refreshRecent(environmentId);
    const immediate: Array<string> = [];
    for (const motion of motions) {
      const tile = tiles.get(motion.key);
      if (motion.kind === "enter") {
        const was = unpark(motion.key);
        if (was === undefined) oneShot(tile, "factory-tile-enter");
        // A tile folded into a lane's `+N` has no element to fly to.
        else if (tile !== undefined) slide(tile, was, motion.to);
      } else if (motion.kind === "slide") {
        const from = departed.get(motion.key);
        // A tile folded into a lane's `+N` has no element to fly from or to.
        if (tile === undefined || from === undefined) continue;
        slide(tile, from, motion.to);
      } else if (motion.kind === "exit") {
        const from = departed.get(motion.key);
        if (from === undefined) continue;
        const ghost = ghostOf(layer, from.node, from.rect);
        const timer = setTimeout(() => {
          parked.delete(motion.key);
          fadeAway(ghost);
        }, PARK_MS);
        parked.set(motion.key, { ghost, node: from.node, timer });
      } else {
        const from = motion.kind === "leave" ? departed.get(motion.key) : unpark(motion.key);
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
          // Only Done has a post.
          if (motion.to === "done") oneShot(find('[data-post="done"]'), "factory-post-flash");
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
 * `prefers-reduced-motion`, move nothing. `refreshRecent` reads a recent runs list at once.
 */
export function useBeltMotion(
  belt: Belt,
  live: boolean,
  refreshRecent: (environmentId: EnvironmentId) => void,
) {
  const [motion] = useState(createMotion);
  const [seen, setSeen] = useState(FIRST_READ);

  if (live) {
    const places = placesOf(belt);
    if (seen.places === null || !samePlaces(seen.places, places)) {
      const changes = tileMotions(seen.places, places);
      const motions = reducedMotion() ? [] : changes;
      const landing = new Set(seen.landing);
      for (const { kind, key } of motions) {
        if (kind === "leave" || kind === "arrive") landing.add(key);
      }
      // Whatever the motion, a run that dropped off the rail is a bin that is out of date.
      const refresh = new Set<EnvironmentId>();
      for (const change of changes) {
        const environmentId =
          change.kind === "exit" ? seen.environments.get(change.key) : undefined;
        if (environmentId !== undefined) refresh.add(environmentId);
      }
      setSeen({
        places,
        environments: environmentsOf(belt),
        motions,
        refresh: Array.from(refresh),
        landing,
      });
    }
  }

  // Last child of the belt, so it is set after every tile ref of the commit that shows the motions.
  const layerRef = (layer: HTMLDivElement | null) => {
    if (layer === null) return;
    motion.play(layer, seen.motions, seen.refresh, refreshRecent, (keys) =>
      setSeen((current) => {
        const landing = new Set(current.landing);
        for (const key of keys) landing.delete(key);
        return { ...current, landing };
      }),
    );
  };

  return { shown: holdBins(belt, seen.landing), tileRef: motion.tileRef, layerRef };
}

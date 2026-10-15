import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type {
  MachineId,
  MachineMapDocument,
  MachineRecord,
  MapChange,
  MapNote,
  MapPosition,
  PairOffset,
} from "@t3tools/contracts/machineMap";

import { usesText } from "../rules/access.ts";
import { findArrow, findNote, MAP_FRAME, pairOffset } from "../rules/map.ts";
import { NO_SELECTION, type Route } from "./route.ts";
import { usePortalContext } from "./context.ts";
import { buildStandings } from "./build.ts";
import { BuildLabel, BuildSticker } from "./BuildLabel.tsx";
import {
  arrowEndRoute,
  arrowEndWait,
  arrowEnds,
  connectMachines,
  cutLevel,
  pairCut,
  pairShows,
} from "./derive.ts";
import {
  LEVEL_LABEL,
  PRESENCE_STICKER,
  presenceState,
  timeAgo,
  TOWARD_TEXT,
  towardGlyph,
} from "./format.ts";
import { ClockIcon, KindIcon } from "./icons.tsx";
import {
  anyInView,
  fitView,
  offsetPoint,
  pairPath,
  placePairs,
  pointOffset,
  separate,
  toMapPoint,
  toScreenPoint,
  zoomAt,
  clampZoom,
  type Box,
  type MapViewport,
  type Point,
} from "./layout.ts";
import { NoteCard } from "./NoteCard.tsx";
import { settleHeld, type Held } from "./store.ts";
import { MachineStickers } from "./MachineStickers.tsx";
import { CardMeters } from "./resources.tsx";
import { RouteLink } from "./StickerLink.tsx";

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** Pointer moves under this many pixels are a tap, not a drag. */
const TAP_PIXELS = 5;
/** MM-1110: holding a finger this long on empty map opens the add menu. */
const LONG_PRESS_MS = 550;
/** A map narrower than this uses the compact cards. The CSS class `compact` follows it. */
const COMPACT_WIDTH = 640;
/** Card sizes before the page measures them. The first paint already uses the measured sizes. */
const ESTIMATE = {
  wide: { node: { w: 224, h: 120 }, pair: { w: 330, h: 96 }, note: { w: 190, h: 80 } },
  compact: { node: { w: 156, h: 100 }, pair: { w: 200, h: 84 }, note: { w: 140, h: 60 } },
} as const;

/** MM-1116: the zoom and pan of this device. Each device keeps its own; the map never holds it. */
const VIEW_KEY = "machine-map:view";
/** Each "+" or "−" press zooms by this factor. */
const ZOOM_STEP = 1.25;
/** Wheel pixels to zoom: a trackpad pinch sends small steps, a mouse wheel big ones. */
const WHEEL_ZOOM_RATE = 0.005;
const WHEEL_ZOOM_MAX_DELTA = 50;
/** A wheel `deltaMode` of lines scrolls this many pixels per line. */
const LINE_PIXELS = 16;

function loadView(): MapViewport | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { x, y, k } = value as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number" || typeof k !== "number") return null;
    if (![x, y, k].every(Number.isFinite) || k <= 0) return null;
    return { x, y, k: clampZoom(k) };
  } catch {
    return null;
  }
}

function storeView(view: MapViewport): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  } catch {
    // Private windows can refuse storage. The view then lasts until the page closes.
  }
}

/** A key press or a wheel in a text field or a select types or scrolls it; it never pans or zooms the map. */
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Space on a button, a link, a card or in a dialog presses or types; it never pans the map. */
const keepsSpace = (target: EventTarget | null) =>
  document.querySelector("dialog[open]") !== null ||
  (target instanceof Element &&
    target.closest("button, a[href], [role='button'], summary, dialog") !== null);

interface Size {
  readonly w: number;
  readonly h: number;
}

/** What a drag moves: a machine (MM-206), the card of a pair (MM-1108) or a note (MM-1109). */
type DragSubject =
  | { readonly _tag: "machine"; readonly machine: MachineRecord }
  | { readonly _tag: "pair"; readonly a: MachineRecord; readonly b: MachineRecord }
  | { readonly _tag: "note"; readonly note: MapNote }
  /** MM-1104: a line from a handle of a machine. Dropping it on another machine connects them. */
  | { readonly _tag: "connect"; readonly machine: MachineRecord };

/** MM-1104: the edges of a machine card that hold a connection handle. */
const HANDLE_SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * One drag in progress. Pointer moves change it in place and paint on the next frame, so a drag
 * does not render the map on every move. Points are card centers in map pixels.
 */
interface Drag {
  readonly subject: DragSubject;
  /** The card. It captures the pointer once the drag moves, so a tap still reaches its buttons. */
  readonly element: HTMLElement;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  /** Where the pointer holds the card, from its center, so the card does not jump. */
  readonly grab: Point;
  /** The card center before the drag. */
  readonly from: Point;
  clientX: number;
  clientY: number;
  at: Point;
  moved: boolean;
  /** MM-1104: the machine under the pointer while a connection line moves. Dropping here connects. */
  target: MachineId | null;
}

const pairKey = (a: MachineRecord, b: MachineRecord) => `${a.id}>${b.id}`;
const samePosition = (a: MapPosition, b: MapPosition) => a.x === b.x && a.y === b.y;
const sameOffset = (a: PairOffset, b: PairOffset) => a.along === b.along && a.aside === b.aside;
const sameSizes = (a: Record<string, Size>, b: Record<string, Size>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(b).every(([key, size]) => {
    const old = a[key];
    return old !== undefined && Math.abs(old.w - size.w) < 1 && Math.abs(old.h - size.h) < 1;
  });
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Enter and Space press a card that is not a button element. */
const onPressKey = (press: () => void) => (event: KeyboardEvent) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    press();
  }
};

/** The map, its moving layer or its line layer, not a card on it. */
const isEmptySpot = (target: EventTarget, map: EventTarget, world: EventTarget | null) =>
  target === map || target === world || (target instanceof Element && target.tagName === "svg");

/** MM-602: one arrow end that did not apply the arrow, in words, and where it opens. */
interface Wait {
  readonly text: string;
  readonly route: Route;
}

/** A note that the page shows: a saved one, or a new one that is not saved yet. */
interface EditingNote {
  readonly note: MapNote;
  readonly saved: boolean;
}

export function MapView({ map, readOnly }: { map: MachineMapDocument; readOnly: boolean }) {
  const portal = usePortalContext();
  const { snapshot, route, now } = portal;
  const ref = useRef<HTMLDivElement>(null);
  /** MM-1116: the layer that holds every card. One CSS transform on it pans and zooms. */
  const worldRef = useRef<HTMLDivElement>(null);
  const view = useRef<MapViewport>({ x: 0, y: 0, k: 1 });
  const viewReady = useRef(false);
  const storeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A pan of the view: a drag on empty map, Space and a drag, or one finger on empty map. */
  const pan = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    from: MapViewport;
    moved: boolean;
  } | null>(null);
  /** The fingers on the map, by pointer id, in client pixels. Two of them pinch. */
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; middle: Point; from: MapViewport } | null>(null);
  const spaceHeld = useRef(false);
  const hovered = useRef(false);
  /**
   * MM-1117: a plain wheel pans the live map only after a click, a drag or keyboard focus on it.
   * Before that, and after the pointer leaves or Esc, the wheel scrolls the page.
   */
  const engaged = useRef(false);
  /** False until the user zooms or pans, so the first "Fit" follows cards that grow (MM-1118). */
  const userMoved = useRef(false);
  const fittedFor = useRef("");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  /** A drag that moved ends with a click on its card. That click is not a tap. */
  const swallowClick = useRef(false);
  const longPress = useRef<{
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
  } | null>(null);
  /** The drop target, kept in state so the target card renders its look. */
  const [target, setTarget] = useState<MachineId | null>(null);
  /** MM-1104: the source machine of the connection line that follows the pointer. */
  const [linking, setLinking] = useState<MachineId | null>(null);
  /**
   * MM-1110: the add menu, at a point on the map and the screen point where it opened. A pan or
   * zoom closes it, so the screen point stays true.
   */
  const [menu, setMenu] = useState<{ readonly at: Point; readonly screen: Point } | null>(null);
  const [editing, setEditing] = useState<EditingNote | null>(null);
  // Each state keeps at most one entry per card. The save answer gives each entry its revision,
  // which the map then reaches, or removes the entry. So the page does not prune the state.
  const [heldPlaceState, setHeldPlaces] = useState<ReadonlyArray<Held<MapPosition>>>([]);
  const [heldOffsetState, setHeldOffsets] = useState<ReadonlyArray<Held<PairOffset>>>([]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Cards size to their text. Measure them after each render, before the browser paints, so the
  // layout below never paints with a guess.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const next: Record<string, Size> = {};
    for (const element of root.querySelectorAll<HTMLElement>("[data-size-key]")) {
      const key = element.dataset.sizeKey;
      if (key) next[key] = { w: element.offsetWidth, h: element.offsetHeight };
    }
    setSizes((current) => (sameSizes(current, next) ? current : next));
  });

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (longPress.current) clearTimeout(longPress.current.timer);
    },
    [],
  );

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [menu]);

  const compact = size.width < COMPACT_WIDTH;
  const estimate = compact ? ESTIMATE.compact : ESTIMATE.wide;
  const machines = map.machines;
  const standings = buildStandings(snapshot.presence);
  const selection = route.selection;
  const focus = selection._tag === "machine" ? selection.id : null;
  const focusMachine = machines.find((m) => m.id === focus);
  // MM-1103: a pair with no access either way has no line and no card. The Table view and the
  // command palette still list its arrows. MM-717: while paused, a pair that the pause cut stays.
  const pairs: Array<[MachineRecord, MachineRecord]> = [];
  for (let i = 0; i < machines.length; i++) {
    for (let j = i + 1; j < machines.length; j++) {
      const a = machines[i];
      const b = machines[j];
      if (a && b && (pairShows(map, a.id, b.id) || pairCut(portal.pause, a.id, b.id)))
        pairs.push([a, b]);
    }
  }

  // MM-1114: the map has no edges. Places are map pixels, so a card that grows or a new machine
  // never moves the other cards. Zoom and pan show any part of it (MM-1116, MM-1117).
  /** The size of the cards together. It changes when a card grows, never on a drop. */
  const cardArea = [
    ...machines.map((m) => sizes[`node:${m.id}`] ?? estimate.node),
    ...pairs.map((pair) => sizes[`pair:${pairKey(...pair)}`] ?? estimate.pair),
    ...map.notes.map((note) => sizes[`note:${note.id}`] ?? estimate.note),
  ].reduce((sum, { w, h }) => sum + w * h, 0);

  const heldPlaces = settleHeld(
    heldPlaceState,
    map.revision,
    (key) =>
      (
        map.machines.find((m) => `machine:${m.id}` === key) ??
        map.notes.find((n) => `note:${n.id}` === key)
      )?.position,
    samePosition,
  );
  const heldOffsets = settleHeld(
    heldOffsetState,
    map.revision,
    (key) => {
      const pair = pairs.find((p) => pairKey(...p) === key);
      if (!pair) return undefined;
      // An automatic place differs from every held offset.
      return pairOffset(map, pair[0].id, pair[1].id) ?? { along: -1, aside: 0 };
    },
    sameOffset,
  );

  const heldPlace = (key: string) => heldPlaces.find((h) => h.key === key)?.value;
  const position = (m: MachineRecord): MapPosition => heldPlace(`machine:${m.id}`) ?? m.position;
  const offsetOf = (a: MachineRecord, b: MachineRecord): PairOffset | null =>
    heldOffsets.find((h) => h.key === pairKey(a, b))?.value ?? pairOffset(map, a.id, b.id);
  const toPixels = (p: MapPosition): Point => p;
  /** A map point as a place to save, in whole map pixels. */
  const toPosition = (p: Point): MapPosition => ({ x: Math.round(p.x), y: Math.round(p.y) });
  const nodeBox = (m: MachineRecord, p: Point): Box => ({
    ...p,
    ...(sizes[`node:${m.id}`] ?? estimate.node),
  });

  const noteSize = (note: MapNote): Size => sizes[`note:${note.id}`] ?? estimate.note;
  const savedNoteAt = (note: MapNote): Point =>
    toPixels(heldPlace(`note:${note.id}`) ?? note.position);

  /**
   * The machines and notes where the page shows them: saved places, pushed apart (see
   * `layout.ts`), so a note never covers a machine card on a narrow map.
   */
  const spread = separate([
    ...machines.map((m) => nodeBox(m, toPixels(position(m)))),
    ...map.notes.map((note) => ({ ...savedNoteAt(note), ...noteSize(note) })),
  ]);
  const nodes = spread.slice(0, machines.length);
  const noteBoxes = spread.slice(machines.length);
  const noteAt = (note: MapNote): Point =>
    noteBoxes[map.notes.findIndex((n) => n.id === note.id)] ?? savedNoteAt(note);

  /**
   * Where each card goes. During a drag the dragged machine follows the pointer and the other
   * machines stay. Automatic pair cards then move out of its way; placed ones follow their line.
   */
  const layout = (dragged: { readonly id: MachineId; readonly at: Point } | null) => {
    const boxes = machines.map((m, i) => {
      const settled = nodes[i] ?? nodeBox(m, toPixels(m.position));
      return m.id === dragged?.id ? nodeBox(m, dragged.at) : settled;
    });
    const at = new Map(
      machines.map((m, i) => [m.id, boxes[i] ?? nodeBox(m, toPixels(m.position))]),
    );
    const spots = placePairs(
      pairs.map(([a, b]) => {
        const pa = at.get(a.id) ?? toPixels(a.position);
        const pb = at.get(b.id) ?? toPixels(b.position);
        const offset = offsetOf(a, b);
        return {
          a: pa,
          b: pb,
          ...(sizes[`pair:${pairKey(a, b)}`] ?? estimate.pair),
          fixed: offset ? offsetPoint(pa, pb, offset) : null,
        };
      }),
      boxes,
      noteBoxes,
    );
    return { at, spots };
  };
  const shown = layout(null);
  const centerOf = (m: MachineRecord): Point => shown.at.get(m.id) ?? toPixels(position(m));

  const moveElement = (element: HTMLElement, p: Point) => {
    element.style.left = `${p.x}px`;
    element.style.top = `${p.y}px`;
  };

  /** MM-1108: redraws the line of a pair, through its card when the owner placed the card. */
  const drawPair = (root: HTMLElement, key: string, a: Point, b: Point, through: Point | null) =>
    root
      .querySelector<SVGPathElement>(`path[data-pair="${CSS.escape(key)}"]`)
      ?.setAttribute("d", pairPath(a, b, through));

  /** Writes the place of the dragged card straight to the page, with every line it moves. */
  const paint = (subject: DragSubject, p: Point, element: HTMLElement) => {
    const root = ref.current;
    if (!root) return;
    if (subject._tag === "connect") {
      const line = root.querySelector<SVGLineElement>("line.live");
      const from = centerOf(subject.machine);
      line?.setAttribute("x1", String(from.x));
      line?.setAttribute("y1", String(from.y));
      line?.setAttribute("x2", String(p.x));
      line?.setAttribute("y2", String(p.y));
      return;
    }
    if (subject._tag === "pair") {
      moveElement(element, p);
      // A card that moves is a placed card, so its line bends through it.
      drawPair(root, pairKey(subject.a, subject.b), centerOf(subject.a), centerOf(subject.b), p);
      return;
    }
    if (subject._tag !== "machine") {
      moveElement(element, p);
      return;
    }
    const id = subject.machine.id;
    const { at, spots } = layout({ id, at: p });
    const q = at.get(id);
    if (q) moveElement(element, q);
    const spotByPair = new Map(pairs.map((pair, i) => [pairKey(...pair), spots[i]]));
    for (const [a, b] of pairs) {
      const pa = at.get(a.id);
      const pb = at.get(b.id);
      const spot = spotByPair.get(pairKey(a, b));
      if (pa && pb) drawPair(root, pairKey(a, b), pa, pb, offsetOf(a, b) && spot ? spot : null);
      const card = root.querySelector<HTMLElement>(
        `.pair[data-pair="${CSS.escape(pairKey(a, b))}"]`,
      );
      if (card && spot) moveElement(card, spot);
    }
  };

  /** A point on the screen in pixels of the map element, inside its border. */
  const screenAt = (clientX: number, clientY: number): Point => {
    const element = ref.current;
    if (!element) return { x: 0, y: 0 };
    const rect = element.getBoundingClientRect();
    return {
      x: clientX - rect.left - element.clientLeft,
      y: clientY - rect.top - element.clientTop,
    };
  };
  /** MM-1116: a client point in map pixels, through the zoom and pan, so drops save map places. */
  const mapAt = (clientX: number, clientY: number): Point =>
    toMapPoint(view.current, screenAt(clientX, clientY));

  /** Moves the drag to the last pointer. Runs at most once per frame. */
  const step = () => {
    const current = drag.current;
    if (!current || !current.moved) return;
    const { clientX, clientY } = current;
    const p = mapAt(clientX, clientY);
    current.at = {
      x: p.x - current.grab.x,
      y: p.y - current.grab.y,
    };
    if (current.subject._tag === "connect") {
      const id = current.subject.machine.id;
      const under = document
        .elementsFromPoint(clientX, clientY)
        .map((element) => element.closest<HTMLElement>("[data-machine-id]")?.dataset.machineId)
        .find((found) => found !== undefined && found !== id);
      const nextTarget = machines.find((m) => m.id === under)?.id ?? null;
      if (nextTarget !== current.target) {
        current.target = nextTarget;
        setTarget(nextTarget);
      }
    }
    paint(current.subject, current.at, current.element);
  };
  // The frame callback runs the newest step, so it paints with the newest map and size.
  const latestStep = useRef(step);
  useLayoutEffect(() => {
    latestStep.current = step;
    // A render during a drag, for example for a revision from another page, writes the saved
    // place. Put the dragged card back under the pointer before the browser paints.
    const current = drag.current;
    if (current?.moved) paint(current.subject, current.at, current.element);
  });

  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  const cancelLongPress = () => {
    if (longPress.current) clearTimeout(longPress.current.timer);
    longPress.current = null;
  };

  /** The pointer in map pixels. */
  const pointerAt = (event: PointerEvent<HTMLElement>): Point =>
    mapAt(event.clientX, event.clientY);

  const startDrag = (event: PointerEvent<HTMLElement>, subject: DragSubject, center: Point) => {
    if (readOnly || event.button !== 0 || touches.current.size > 1) return;
    const grabAt = pointerAt(event);
    swallowClick.current = false;
    drag.current = {
      subject,
      element: event.currentTarget,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grab: { x: grabAt.x - center.x, y: grabAt.y - center.y },
      from: center,
      clientX: event.clientX,
      clientY: event.clientY,
      at: center,
      moved: false,
      target: null,
    };
  };

  /** MM-1116: writes the view to the map layer. No render: one transform moves every card. */
  const applyView = () => {
    const { x, y, k } = view.current;
    if (worldRef.current)
      worldRef.current.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
  };
  /** Keeps the view of this device, after the gesture settles. A history map keeps none. */
  const keepView = () => {
    if (readOnly) return;
    if (storeTimer.current !== null) clearTimeout(storeTimer.current);
    storeTimer.current = setTimeout(() => {
      storeTimer.current = null;
      storeView(view.current);
    }, 250);
  };
  /** A user change of the view. Fit and the first view set `view` directly instead. */
  const setView = (next: MapViewport) => {
    userMoved.current = true;
    view.current = { ...next, k: clampZoom(next.k) };
    applyView();
    // The add menu sits at a screen point, so a pan or zoom closes it.
    if (menu) setMenu(null);
  };

  /** Every card as a box in map pixels. */
  const cardBoxes = (): Array<Box> => [
    ...machines.flatMap((m) => {
      const box = shown.at.get(m.id);
      return box ? [box] : [];
    }),
    ...pairs.map((pair, i) => ({
      ...(shown.spots[i] ?? { x: 0, y: 0 }),
      ...(sizes[`pair:${pairKey(...pair)}`] ?? estimate.pair),
    })),
    ...noteBoxes,
  ];
  /** MM-1116 "Fit": every card in view. An empty map shows its middle at 100%. */
  const fitted = (): MapViewport =>
    fitView(cardBoxes(), size.width, size.height) ?? {
      x: (size.width - MAP_FRAME.width) / 2,
      y: (size.height - MAP_FRAME.height) / 2,
      k: 1,
    };
  const fit = () => setView(fitted());
  const zoomBy = (factor: number) =>
    setView(zoomAt(view.current, { x: size.width / 2, y: size.height / 2 }, factor));

  // The first view: the one this device kept, or "Fit" on a first visit and when the kept view
  // shows no card. It waits for the measured card sizes, which come before the first paint.
  // Until the user zooms or pans, "Fit" runs again when a card or the map element changes size,
  // for example when a machine comes online and its card grows. A drop of a card keeps the view.
  // React never writes the transform, so each render puts it back.
  const measured = machines.length + map.notes.length === 0 || Object.keys(sizes).length > 0;
  useLayoutEffect(() => {
    if (size.width > 0 && measured) {
      const boxes = cardBoxes();
      // Card area changes when a card grows, never on a drop.
      const layout = [size.width, size.height, boxes.length, cardArea / 100]
        .map(Math.round)
        .join(",");
      if (!viewReady.current) {
        viewReady.current = true;
        const kept = readOnly ? null : loadView();
        if (kept && anyInView(kept, boxes, size.width, size.height)) {
          view.current = kept;
          userMoved.current = true;
        } else view.current = fitted();
        fittedFor.current = layout;
      } else if (!userMoved.current && fittedFor.current !== layout) {
        view.current = fitted();
        fittedFor.current = layout;
      }
    }
    applyView();
  });

  /** Saves a waiting view at once: on unmount and when the page hides (MM-1118). */
  const flushView = () => {
    if (storeTimer.current === null) return;
    clearTimeout(storeTimer.current);
    storeTimer.current = null;
    storeView(view.current);
  };
  const latestFlush = useRef(flushView);
  useEffect(() => {
    const listener = () => latestFlush.current();
    addEventListener("pagehide", listener);
    return () => {
      removeEventListener("pagehide", listener);
      latestFlush.current();
    };
  }, []);

  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    pan.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: view.current,
      moved: false,
    };
  };

  /** Ends a pan. True when the event belonged to it. */
  const endPan = (event: PointerEvent<HTMLDivElement>): boolean => {
    const current = pan.current;
    if (!current || current.pointerId !== event.pointerId) return false;
    pan.current = null;
    cancelLongPress();
    ref.current?.classList.remove("panning");
    // A pan that moved ends with a click on the map. That click is not a tap.
    if (current.moved) {
      swallowClick.current = true;
      keepView();
    }
    return true;
  };

  /**
   * MM-1116: fingers and Space. A second finger starts a pinch and stops the drag or pan of the
   * first. Space and a drag pan from anywhere, also over a card.
   */
  const onMapPointerDownCapture = (event: PointerEvent<HTMLDivElement>) => {
    engaged.current = true;
    if (event.pointerType === "touch") {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.current.size === 2) {
        const [a, b] = [...touches.current.values()];
        if (!a || !b) return;
        abortDrag();
        pan.current = null;
        cancelLongPress();
        pinch.current = {
          distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
          middle: screenAt((a.x + b.x) / 2, (a.y + b.y) / 2),
          from: view.current,
        };
        event.stopPropagation();
        return;
      }
      if (touches.current.size > 2) event.stopPropagation();
    }
    if (spaceHeld.current && event.button === 0) {
      startPan(event);
      event.stopPropagation();
    }
  };

  /** MM-1110: a long press on empty map opens the add menu. A finger has no double click. */
  const onMapPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    swallowClick.current = false;
    if (event.button !== 0 || !isEmptySpot(event.target, event.currentTarget, worldRef.current))
      return;
    // MM-1116: a drag on empty map pans.
    startPan(event);
    if (readOnly || event.pointerType === "mouse") return;
    const point = pointerAt(event);
    cancelLongPress();
    longPress.current = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        longPress.current = null;
        swallowClick.current = true;
        setMenu({ at: point, screen: toScreenPoint(view.current, point) });
      }, LONG_PRESS_MS),
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pinching = pinch.current;
    if (pinching && touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const [a, b] = [...touches.current.values()];
      if (!a || !b) return;
      const middle = screenAt((a.x + b.x) / 2, (a.y + b.y) / 2);
      const k = clampZoom((pinching.from.k * Math.hypot(b.x - a.x, b.y - a.y)) / pinching.distance);
      // The map point under the first middle follows the fingers.
      const p = toMapPoint(pinching.from, pinching.middle);
      setView({ k, x: middle.x - p.x * k, y: middle.y - p.y * k });
      return;
    }
    const panning = pan.current;
    if (panning && panning.pointerId === event.pointerId) {
      const dx = event.clientX - panning.startX;
      const dy = event.clientY - panning.startY;
      if (!panning.moved && Math.hypot(dx, dy) > TAP_PIXELS) {
        panning.moved = true;
        cancelLongPress();
        ref.current?.setPointerCapture(event.pointerId);
        ref.current?.classList.add("panning");
      }
      if (panning.moved)
        setView({ ...panning.from, x: panning.from.x + dx, y: panning.from.y + dy });
      return;
    }
    const press = longPress.current;
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_PIXELS)
      cancelLongPress();
    const current = drag.current;
    if (!current) return;
    current.clientX = event.clientX;
    current.clientY = event.clientY;
    if (
      !current.moved &&
      Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > TAP_PIXELS
    ) {
      current.moved = true;
      // Only a moving drag takes the pointer: a tap on a pair row stays a click on that row.
      current.element.setPointerCapture(current.pointerId);
      if (current.subject._tag === "connect") setLinking(current.subject.machine.id);
      // The dragged card rides above every other card.
      else current.element.classList.add("dragging");
    }
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      latestStep.current();
    });
  };

  /** Ends the drag and paints the place that the next render shows. */
  const endDrag = (event: PointerEvent<HTMLDivElement>): Drag | null => {
    cancelLongPress();
    const current = drag.current;
    if (!current) return null;
    current.clientX = event.clientX;
    current.clientY = event.clientY;
    cancelFrame();
    step();
    drag.current = null;
    current.element.classList.remove("dragging");
    setTarget(null);
    setLinking(null);
    swallowClick.current = current.moved;
    return current;
  };

  const toggle = (machine: MachineRecord) =>
    portal.select(focus === machine.id ? NO_SELECTION : { _tag: "machine", id: machine.id });

  /** A dropped machine settles beside the others, not on top of one. The others stay. */
  const settle = (id: MachineId, p: Point): MapPosition => {
    const index = machines.findIndex((m) => m.id === id);
    const machine = machines[index];
    if (!machine) return toPosition(p);
    const boxes = [
      ...machines.map((m, i) =>
        i === index ? nodeBox(m, p) : (nodes[i] ?? nodeBox(m, toPixels(m.position))),
      ),
      ...noteBoxes,
    ];
    const fixed = new Set([...boxes.keys()].filter((i) => i !== index));
    const box = separate(boxes, fixed)[index];
    return toPosition(box ?? p);
  };

  /**
   * Saves a dropped place. The page holds it until the map has it (no snap back). A held draft
   * shows through the map; a proposal or a failure shows the saved place.
   */
  const save = <T,>(
    setHeld: (update: (current: ReadonlyArray<Held<T>>) => ReadonlyArray<Held<T>>) => void,
    key: string,
    value: T,
    summary: string,
    change: MapChange,
  ) => {
    const hold: Held<T> = { key, value, revision: null };
    setHeld((current) => [...current.filter((h) => h.key !== key), hold]);
    void portal
      .submit(summary, [change], { quiet: true })
      .then((outcome) =>
        setHeld((current) =>
          outcome._tag === "applied"
            ? current.map((h) => (h === hold ? { ...h, revision: outcome.revision } : h))
            : current.filter((h) => h !== hold),
        ),
      );
  };

  /** Forgets a finger. A pinch ends when fewer than two stay; its click is not a tap. */
  const releaseTouch = (event: PointerEvent<HTMLDivElement>) => {
    touches.current.delete(event.pointerId);
    if (pinch.current && touches.current.size < 2) {
      pinch.current = null;
      swallowClick.current = true;
      keepView();
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    releaseTouch(event);
    if (endPan(event)) return;
    const finished = endDrag(event);
    if (!finished) return;
    const { subject } = finished;
    if (!finished.moved) {
      if (subject._tag === "machine") toggle(subject.machine);
      // A tap on a handle opens the machine, where "Connect to" works without a drag.
      if (subject._tag === "connect") portal.select({ _tag: "machine", id: subject.machine.id });
      return;
    }
    switch (subject._tag) {
      case "machine": {
        const machine = subject.machine;
        const settled = settle(machine.id, finished.at);
        paint(subject, toPixels(settled), finished.element);
        if (samePosition(settled, toPosition(finished.from))) return;
        save(setHeldPlaces, `machine:${machine.id}`, settled, `Moved ${machine.name}`, {
          _tag: "putMachine",
          machine: { ...machine, position: settled },
        });
        return;
      }
      case "pair": {
        const { a, b } = subject;
        const offset = pointOffset(centerOf(a), centerOf(b), finished.at);
        const current = offsetOf(a, b);
        if (current && sameOffset(current, offset)) return;
        save(setHeldOffsets, pairKey(a, b), offset, `Moved the card of ${a.name} and ${b.name}`, {
          _tag: "placePair",
          a: a.id,
          b: b.id,
          offset,
        });
        return;
      }
      case "connect": {
        // A drop on empty map cancels.
        const to = machines.find((m) => m.id === finished.target);
        if (to) connectMachines(portal, subject.machine, to);
        return;
      }
      case "note": {
        const note = subject.note;
        const placed = toPosition(finished.at);
        if (samePosition(placed, note.position)) return;
        save(setHeldPlaces, `note:${note.id}`, placed, "Moved a note", {
          _tag: "putNote",
          note: { ...note, position: placed },
        });
        return;
      }
    }
  };

  /** Puts a dragged card back where it was, for a cancelled drag. */
  const putBack = (finished: Drag) => {
    if (!finished.moved) return;
    paint(finished.subject, finished.from, finished.element);
    const { subject } = finished;
    // A card in its automatic place goes back to a straight line.
    if (subject._tag === "pair" && offsetOf(subject.a, subject.b) === null && ref.current)
      drawPair(
        ref.current,
        pairKey(subject.a, subject.b),
        centerOf(subject.a),
        centerOf(subject.b),
        null,
      );
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    releaseTouch(event);
    if (endPan(event)) return;
    const finished = endDrag(event);
    if (finished) putBack(finished);
  };

  /** MM-1116: a pinch stops a card drag that the first finger started. */
  const abortDrag = () => {
    const current = drag.current;
    if (!current) return;
    cancelFrame();
    drag.current = null;
    current.element.classList.remove("dragging");
    setTarget(null);
    setLinking(null);
    putBack(current);
  };

  /**
   * MM-1116, MM-1117: Ctrl or Cmd and the wheel, or a trackpad pinch (the browser sends it with
   * Ctrl), zoom at the pointer. A plain wheel or a two-finger scroll pans the live map once it is
   * engaged; otherwise, and on the History map, it scrolls the page. A note in edit mode scrolls.
   */
  const onWheel = (event: WheelEvent) => {
    if (isTyping(event.target)) return;
    const zoom = event.ctrlKey || event.metaKey;
    if (!zoom && (readOnly || !engaged.current)) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? LINE_PIXELS : 1;
    if (zoom) {
      const delta = clamp(event.deltaY * unit, -WHEEL_ZOOM_MAX_DELTA, WHEEL_ZOOM_MAX_DELTA);
      setView(
        zoomAt(
          view.current,
          screenAt(event.clientX, event.clientY),
          Math.exp(-delta * WHEEL_ZOOM_RATE),
        ),
      );
    } else {
      setView({
        ...view.current,
        x: view.current.x - event.deltaX * unit,
        y: view.current.y - event.deltaY * unit,
      });
    }
    keepView();
  };
  const latestWheel = useRef(onWheel);
  // React adds wheel listeners as passive, and a passive listener cannot stop the page scroll.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const listener = (event: WheelEvent) => latestWheel.current(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, []);

  // A finger that lifts outside the map never reaches its handlers. Forget it there too, so a
  // later single finger does not count as a pinch.
  useEffect(() => {
    const forget = (event: globalThis.PointerEvent) => {
      touches.current.delete(event.pointerId);
      if (touches.current.size < 2) pinch.current = null;
      // A fast flick can leave the map before the pan takes the pointer. End that pan here, so
      // hovering later does not pan the map.
      if (pan.current?.pointerId === event.pointerId) {
        pan.current = null;
        ref.current?.classList.remove("panning");
      }
    };
    addEventListener("pointerup", forget);
    addEventListener("pointercancel", forget);
    return () => {
      removeEventListener("pointerup", forget);
      removeEventListener("pointercancel", forget);
    };
  }, []);

  /** MM-1116: Space held over the map pans with a drag. "0" fits every card. */
  const onKey = (event: globalThis.KeyboardEvent) => {
    if (isTyping(event.target)) return;
    if (event.key === "Escape") engaged.current = false;
    if (event.key === " ") {
      // A button presses on key up, so only a Space that the map took ends with the map.
      if (event.type === "keyup") {
        if (!spaceHeld.current) return;
        event.preventDefault();
        spaceHeld.current = false;
        ref.current?.classList.remove("space-pan");
        return;
      }
      if (keepsSpace(event.target)) {
        // A modal over the map gets no pointer leave, so the map forgets the hover here.
        if (document.querySelector("dialog[open]")) hovered.current = false;
        return;
      }
      if (!hovered.current && !spaceHeld.current) return;
      event.preventDefault();
      spaceHeld.current = true;
      ref.current?.classList.add("space-pan");
      return;
    }
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.type === "keydown" && event.key === "0" && plain) {
      fit();
      keepView();
    }
  };
  const latestKey = useRef(onKey);
  useLayoutEffect(() => {
    latestWheel.current = onWheel;
    latestKey.current = onKey;
    latestFlush.current = flushView;
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => latestKey.current(event);
    const release = () => {
      spaceHeld.current = false;
      ref.current?.classList.remove("space-pan");
    };
    addEventListener("keydown", listener);
    addEventListener("keyup", listener);
    addEventListener("blur", release);
    return () => {
      removeEventListener("keydown", listener);
      removeEventListener("keyup", listener);
      removeEventListener("blur", release);
    };
  }, []);

  /** MM-1103: a tap on the empty map ends the focus and closes the add menu. */
  const onMapClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!isEmptySpot(event.target, event.currentTarget, worldRef.current)) return;
    setMenu(null);
    if (selection._tag !== "none") portal.select(NO_SELECTION);
  };

  /** MM-1110: a double click on empty map opens the add menu there. */
  const onMapDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (readOnly || !isEmptySpot(event.target, event.currentTarget, worldRef.current)) return;
    setMenu({
      at: mapAt(event.clientX, event.clientY),
      screen: screenAt(event.clientX, event.clientY),
    });
  };

  const saveNote = (note: MapNote, saved: boolean) => {
    setEditing(null);
    const before = findNote(map, note.id);
    if (before && before.text === note.text && before.color === note.color) return;
    void portal.submit(saved ? "Edited a note" : "Added a note", [{ _tag: "putNote", note }]);
  };

  /** The wait of each arrow end that did not apply the arrow (MM-602, MM-604). */
  const waitOf = (from: MachineRecord, to: MachineRecord): Array<Wait> => {
    if (readOnly) return [];
    const ends = arrowEnds(snapshot, from.id, to.id);
    return [[ends.from, from] as const, [ends.to, to] as const].flatMap(([end, machine]) => {
      const text = arrowEndWait(end, machine);
      return text === null || end === "applied"
        ? []
        : [{ text, route: arrowEndRoute(end, machine.id) }];
    });
  };

  /** MM-1103: "Mac uses Windows ↓": the text gives the direction, the glyph shows the map. */
  const dirRow = (from: MachineRecord, to: MachineRecord, waits: ReadonlyArray<Wait>) => {
    const arrow = findArrow(map, from.id, to.id);
    const was = arrow.level === "none" ? cutLevel(portal.pause, from.id, to.id) : null;
    const toward = towardGlyph(centerOf(from), centerOf(to));
    const on = selection._tag === "arrow" && selection.from === from.id && selection.to === to.id;
    const wait = waits.map((w) => sentence(w.text)).join(". ");
    return (
      <button
        type="button"
        className={`dir${on ? " on" : ""}`}
        aria-label={`${usesText(from.name, to.name)}: ${was ? `cut by the pause, was ${LEVEL_LABEL[was]}` : LEVEL_LABEL[arrow.level]}${wait ? `. ${wait}` : ""}`}
        onClick={() => portal.select({ _tag: "arrow", from: from.id, to: to.id })}
      >
        <span className="who">
          <span className="nm">{from.name}</span>
          <span className="verb">uses</span>
          <span className="nm">{to.name}</span>
          <span className="toward" data-tip={`${to.name} is ${TOWARD_TEXT[toward]}`}>
            {toward}
          </span>
        </span>
        <span className="actions">
          {wait && <ClockIcon label={wait} />}
          {arrow.expiresAt && <span className="sticker warn flat">temp</span>}
          {arrow.agentTools && <span className="sticker accent flat">tools</span>}
          {was ? (
            <>
              <span className={`sticker lvl-${was} was`}>{LEVEL_LABEL[was]}</span>
              <span className="sticker cut-sticker">cut</span>
            </>
          ) : (
            <span className={`sticker lvl-${arrow.level}`}>{LEVEL_LABEL[arrow.level]}</span>
          )}
        </span>
      </button>
    );
  };

  const notes: ReadonlyArray<EditingNote> = [
    ...map.notes.map((note) => (editing?.note.id === note.id ? editing : { note, saved: true })),
    ...(editing && !editing.saved ? [editing] : []),
  ];

  return (
    <div className="map-wrap">
      {/* The bar keeps its height in every state, so the map never moves when focus changes. */}
      {!readOnly && (
        <div className="map-bar" role="status">
          {focusMachine ? (
            <>
              <span>
                Arrows of <b>{focusMachine.name}</b>
              </span>
              <button
                type="button"
                className="btn small"
                aria-keyshortcuts="Escape"
                onClick={() => portal.select(NO_SELECTION)}
              >
                Show all <kbd>Esc</kbd>
              </button>
            </>
          ) : (
            <span className="muted">
              {compact
                ? "Tap a machine to focus it. Drag a dot to connect. Hold empty space to add. Pinch to zoom."
                : "Tap a machine to focus it. Drag a dot on its edge onto another machine to connect them. Double-click empty space to add a machine or a note. Drag empty space to pan, Ctrl or Cmd and the wheel to zoom."}
            </span>
          )}
        </div>
      )}
      <div
        className={`card map${compact ? " compact" : ""}${focus ? " focused" : ""}${readOnly ? " map-readonly" : ""}`}
        ref={ref}
        onClick={onMapClick}
        onClickCapture={(event) => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          event.stopPropagation();
        }}
        onDoubleClick={onMapDoubleClick}
        onPointerDownCapture={onMapPointerDownCapture}
        onPointerDown={onMapPointerDown}
        onPointerEnter={() => {
          hovered.current = true;
        }}
        onPointerLeave={() => {
          hovered.current = false;
          engaged.current = false;
        }}
        onFocus={() => {
          engaged.current = true;
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) engaged.current = false;
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div className="map-world" ref={worldRef}>
          <svg aria-hidden>
            {pairs.map(([a, b], i) => {
              const pa = centerOf(a);
              const pb = centerOf(b);
              const spot = shown.spots[i];
              const touches = focus === a.id || focus === b.id;
              const empty =
                findArrow(map, a.id, b.id).level === "none" &&
                findArrow(map, b.id, a.id).level === "none";
              const cut = empty && pairCut(portal.pause, a.id, b.id);
              return (
                <path
                  key={pairKey(a, b)}
                  data-pair={pairKey(a, b)}
                  d={pairPath(pa, pb, offsetOf(a, b) && spot ? spot : null)}
                  className={[empty && "empty", cut && "cut", focus && (touches ? "hot" : "dim")]
                    .filter(Boolean)
                    .join(" ")}
                />
              );
            })}
            {linking !== null && <line className="live" />}
          </svg>
          {size.width > 0 &&
            notes.map(({ note, saved }) => (
              <NoteCard
                key={note.id}
                note={note}
                saved={saved}
                at={noteAt(note)}
                readOnly={readOnly}
                editing={editing?.note.id === note.id}
                onPointerDown={(event) => startDrag(event, { _tag: "note", note }, noteAt(note))}
                onEdit={() => setEditing({ note, saved: true })}
                onCancel={() => setEditing(null)}
                onSave={(text, color) => saveNote({ ...note, text, color }, saved)}
                onDelete={() => {
                  setEditing(null);
                  void portal.submit("Deleted a note", [{ _tag: "removeNote", id: note.id }]);
                }}
              />
            ))}
          {size.width > 0 &&
            pairs.map(([a, b], i) => {
              const spot = shown.spots[i] ?? { x: 0, y: 0 };
              const dim = focus !== null && focus !== a.id && focus !== b.id;
              const placed = offsetOf(a, b) !== null;
              const cut = pairCut(portal.pause, a.id, b.id);
              const waitsAB = waitOf(a, b);
              const waitsBA = waitOf(b, a);
              // Each machine that did not apply a direction, named once under the rows.
              const waits = [...new Map([...waitsAB, ...waitsBA].map((w) => [w.text, w])).values()];
              return (
                <div
                  key={`pair:${pairKey(a, b)}`}
                  data-pair={pairKey(a, b)}
                  data-size-key={`pair:${pairKey(a, b)}`}
                  className={`card pair${dim ? " dim" : ""}${placed ? " placed" : ""}${cut ? " cut" : ""}${readOnly ? " readonly" : ""}`}
                  style={{ left: spot.x, top: spot.y }}
                  onPointerDown={(event) => startDrag(event, { _tag: "pair", a, b }, spot)}
                >
                  {dirRow(a, b, waitsAB)}
                  {dirRow(b, a, waitsBA)}
                  {waits.length > 0 && (
                    <div className="pair-wait">
                      {waits.map((w, i) => (
                        <span key={w.text}>
                          {i > 0 && " · "}
                          <RouteLink route={w.route}>{sentence(w.text)}</RouteLink>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          {size.width > 0 &&
            machines.map((machine) => {
              const p = centerOf(machine);
              const presence = snapshot.presence[machine.id];
              const state = presenceState(presence);
              const status = presence?.status ?? null;
              const on = focus === machine.id;
              const dropTarget = target === machine.id;
              // MM-1002: the build gets its own line under the name, so it never cuts off.
              const build = state === "online" && status ? status : null;
              const sub =
                state === "waiting"
                  ? "Waiting to join"
                  : state === "offline"
                    ? `Seen ${timeAgo(presence?.lastSeenAt ?? null, now)}`
                    : build
                      ? null
                      : (machine.hostname ?? "No status yet");
              return (
                <div
                  key={machine.id}
                  data-machine-id={machine.id}
                  data-size-key={`node:${machine.id}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={on}
                  aria-label={`${machine.name}, ${state}`}
                  className={`card node${on ? " on" : ""}${dropTarget ? " target" : ""}${linking === machine.id ? " linking" : ""}${readOnly ? " readonly" : ""}`}
                  style={{ left: p.x, top: p.y }}
                  onPointerDown={(event) =>
                    startDrag(event, { _tag: "machine", machine }, centerOf(machine))
                  }
                  onClick={
                    readOnly ? () => portal.select({ _tag: "machine", id: machine.id }) : undefined
                  }
                  onKeyDown={onPressKey(() => toggle(machine))}
                >
                  <span className={`sticker state ${PRESENCE_STICKER[state]}`}>{state}</span>
                  {!readOnly &&
                    HANDLE_SIDES.map((side) => (
                      // Pointer only: the machine panel has "Connect to" for the keyboard.
                      <span
                        key={side}
                        className={`handle ${side}`}
                        aria-hidden
                        data-tip="Drag onto a machine to connect"
                        data-tip-side={side}
                        onPointerDown={(event) => {
                          // The handle starts a line, not a move of its machine.
                          event.stopPropagation();
                          startDrag(event, { _tag: "connect", machine }, pointerAt(event));
                        }}
                      />
                    ))}
                  <div className="name">
                    <span className="icon">
                      <KindIcon kind={machine.kind} />
                    </span>
                    <span className="label">
                      {machine.name}
                      {sub !== null && <span className="sub">{sub}</span>}
                    </span>
                  </div>
                  {build && (
                    <div className="build-line">
                      <BuildLabel status={build} />
                    </div>
                  )}
                  {!readOnly && <CardMeters machineId={machine.id} />}
                  <div className="tags">
                    <BuildSticker standing={standings.get(machine.id)} />
                    {!readOnly && <MachineStickers machine={machine} />}
                  </div>
                </div>
              );
            })}
        </div>
        {menu && (
          <div
            className="card map-menu"
            role="menu"
            aria-label="Add here"
            style={{
              left: clamp(menu.screen.x, 8, Math.max(8, size.width - 220)),
              top: clamp(menu.screen.y, 8, Math.max(8, size.height - 130)),
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="btn small"
              autoFocus
              onClick={() => {
                setMenu(null);
                portal.open({ _tag: "addMachine", position: toPosition(menu.at) });
              }}
            >
              Add machine here
            </button>
            <button
              type="button"
              role="menuitem"
              className="btn small"
              onClick={() => {
                setMenu(null);
                setEditing({
                  note: {
                    id: crypto.randomUUID(),
                    // The editor opens empty. An empty note is never saved.
                    text: "",
                    color: "yellow",
                    position: toPosition(menu.at),
                  },
                  saved: false,
                });
              }}
            >
              Add note here
            </button>
          </div>
        )}
        {machines.length === 0 && (
          <div className="empty map-empty">
            <span className="stamp">empty</span>
            <h2>No machines yet</h2>
            <p>Add the first machine. It joins with a one-time code and shows here.</p>
            {!readOnly && (
              <button
                type="button"
                className="btn primary"
                onClick={() => portal.open({ _tag: "addMachine" })}
              >
                Add machine
              </button>
            )}
          </div>
        )}
        {/* MM-1116: zoom in, zoom out and fit, in a corner over the map. */}
        <div className="map-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="btn small"
            aria-label="Zoom in"
            data-tip="Zoom in (Ctrl or Cmd and the wheel)"
            onClick={() => {
              zoomBy(ZOOM_STEP);
              keepView();
            }}
          >
            +
          </button>
          <button
            type="button"
            className="btn small"
            aria-label="Zoom out"
            data-tip="Zoom out"
            onClick={() => {
              zoomBy(1 / ZOOM_STEP);
              keepView();
            }}
          >
            −
          </button>
          <button
            type="button"
            className="btn small"
            aria-keyshortcuts="0"
            data-tip="Show every card (0)"
            onClick={() => {
              fit();
              keepView();
            }}
          >
            Fit
          </button>
        </div>
      </div>
    </div>
  );
}

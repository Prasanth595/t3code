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
import { findArrow, findNote, pairOffset } from "../rules/map.ts";
import { NO_SELECTION } from "./route.ts";
import { usePortalContext } from "./context.ts";
import { buildStandings } from "./build.ts";
import { BuildLabel, BuildSticker } from "./BuildLabel.tsx";
import {
  arrowEndWait,
  arrowEnds,
  connectMachines,
  cutLevel,
  machineQueue,
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
  offsetPoint,
  pairPath,
  placePairs,
  pointOffset,
  separate,
  type Box,
  type Point,
} from "./layout.ts";
import { NoteCard } from "./NoteCard.tsx";
import { settleHeld, type Held } from "./store.ts";
import { AlertStickers, CardMeters } from "./resources.tsx";

/** The area machines live in: the map height, and at most 1500 pixels wide, centered. */
const MAX_WIDTH = 1500;
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

/** The map itself or its line layer, not a card on it. */
const isEmptySpot = (target: EventTarget, map: EventTarget) =>
  target === map || (target instanceof Element && target.tagName === "svg");

/** A note that the page shows: a saved one, or a new one that is not saved yet. */
interface EditingNote {
  readonly note: MapNote;
  readonly saved: boolean;
}

export function MapView({ map, readOnly }: { map: MachineMapDocument; readOnly: boolean }) {
  const portal = usePortalContext();
  const { snapshot, route, now } = portal;
  const ref = useRef<HTMLDivElement>(null);
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
  /** MM-1110: the add menu, at a point on the map. */
  const [menu, setMenu] = useState<Point | null>(null);
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
  const width = Math.min(size.width, MAX_WIDTH);
  const left = (size.width - width) / 2;
  /** MM-1108: pair offsets beside the line scale with the shorter side of the map. */
  const scale = Math.min(width, size.height);
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
  const toPixels = (p: MapPosition): Point => ({ x: left + p.x * width, y: p.y * size.height });
  const toPosition = (p: Point): MapPosition => ({
    x: clamp((p.x - left) / width, 0.02, 0.98),
    y: clamp(p.y / size.height, 0.02, 0.98),
  });
  const nodeBox = (m: MachineRecord, p: Point): Box => ({
    ...p,
    ...(sizes[`node:${m.id}`] ?? estimate.node),
  });

  /** A note stays inside the map, also on a narrower screen than the one that placed it. */
  const noteAt = (note: MapNote): Point => {
    const p = toPixels(heldPlace(`note:${note.id}`) ?? note.position);
    const { w, h } = sizes[`note:${note.id}`] ?? estimate.note;
    return {
      x: clamp(p.x, w / 2, Math.max(w / 2, size.width - w / 2)),
      y: clamp(p.y, h / 2, Math.max(h / 2, size.height - h / 2)),
    };
  };

  /** The machines where the page shows them: saved places, pushed apart (see `layout.ts`). */
  const nodes = separate(
    machines.map((m) => nodeBox(m, toPixels(position(m)))),
    size.width,
    size.height,
  );

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
          fixed: offset ? offsetPoint(pa, pb, offset, scale) : null,
        };
      }),
      boxes,
      size.width,
      size.height,
      map.notes.map((note) => ({
        ...noteAt(note),
        ...(sizes[`note:${note.id}`] ?? estimate.note),
      })),
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

  /** Moves the drag to the last pointer. Runs at most once per frame. */
  const step = () => {
    const current = drag.current;
    const rect = ref.current?.getBoundingClientRect();
    if (!current || !rect || width === 0 || !current.moved) return;
    const { clientX, clientY } = current;
    current.at = {
      x: clamp(clientX - rect.left - current.grab.x, 0, rect.width),
      y: clamp(clientY - rect.top - current.grab.y, 0, rect.height),
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
  const pointerAt = (event: PointerEvent<HTMLElement>): Point => {
    const rect = ref.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  };

  const startDrag = (event: PointerEvent<HTMLElement>, subject: DragSubject, center: Point) => {
    if (readOnly || event.button !== 0) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    swallowClick.current = false;
    drag.current = {
      subject,
      element: event.currentTarget,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grab: { x: event.clientX - rect.left - center.x, y: event.clientY - rect.top - center.y },
      from: center,
      clientX: event.clientX,
      clientY: event.clientY,
      at: center,
      moved: false,
      target: null,
    };
  };

  /** MM-1110: a long press on empty map opens the add menu. A finger has no double click. */
  const onMapPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    swallowClick.current = false;
    if (readOnly || event.pointerType === "mouse") return;
    if (!isEmptySpot(event.target, event.currentTarget)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    cancelLongPress();
    longPress.current = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        longPress.current = null;
        swallowClick.current = true;
        setMenu(point);
      }, LONG_PRESS_MS),
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
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
    const boxes = machines.map((m, i) =>
      i === index ? nodeBox(m, p) : (nodes[i] ?? nodeBox(m, toPixels(m.position))),
    );
    const fixed = new Set(machines.map((_, i) => i).filter((i) => i !== index));
    const box = separate(boxes, size.width, size.height, fixed)[index];
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

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
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
        const offset = pointOffset(centerOf(a), centerOf(b), finished.at, scale);
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

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    const finished = endDrag(event);
    if (!finished?.moved) return;
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

  /** MM-1103: a tap on the empty map ends the focus and closes the add menu. */
  const onMapClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!isEmptySpot(event.target, event.currentTarget)) return;
    setMenu(null);
    if (selection._tag !== "none") portal.select(NO_SELECTION);
  };

  /** MM-1110: a double click on empty map opens the add menu there. */
  const onMapDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (readOnly || !isEmptySpot(event.target, event.currentTarget)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  const saveNote = (note: MapNote, saved: boolean) => {
    setEditing(null);
    const before = findNote(map, note.id);
    if (before && before.text === note.text && before.color === note.color) return;
    void portal.submit(saved ? "Edited a note" : "Added a note", [{ _tag: "putNote", note }]);
  };

  /** The wait of each arrow end in words, or null when both ends applied it (MM-602, MM-604). */
  const waitOf = (from: MachineRecord, to: MachineRecord): Array<string> => {
    if (readOnly) return [];
    const ends = arrowEnds(snapshot, from.id, to.id);
    return [[ends.from, from] as const, [ends.to, to] as const].flatMap(([end, machine]) => {
      const text = arrowEndWait(end, machine);
      return text === null ? [] : [text];
    });
  };

  /** MM-1103: "Mac uses Windows ↓": the text gives the direction, the glyph shows the map. */
  const dirRow = (from: MachineRecord, to: MachineRecord, waits: ReadonlyArray<string>) => {
    const arrow = findArrow(map, from.id, to.id);
    const was = arrow.level === "none" ? cutLevel(portal.pause, from.id, to.id) : null;
    const toward = towardGlyph(centerOf(from), centerOf(to));
    const on = selection._tag === "arrow" && selection.from === from.id && selection.to === to.id;
    const wait = waits.map(sentence).join(". ");
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
          <span className="toward tip" data-tip={`${to.name} is ${TOWARD_TEXT[toward]}`}>
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
              Tap a machine to focus it. Drag a dot on its edge onto another machine to connect
              them. {compact ? "Hold" : "Double-click"} empty space to add a machine or a note.
            </span>
          )}
        </div>
      )}
      <div
        className={`card map${compact ? " compact" : ""}${focus ? " focused" : ""}`}
        ref={ref}
        onClick={onMapClick}
        onClickCapture={(event) => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          event.stopPropagation();
        }}
        onDoubleClick={onMapDoubleClick}
        onPointerDown={onMapPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
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
            const waits = [...new Set([...waitsAB, ...waitsBA])];
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
                  <div className="pair-wait">{waits.map(sentence).join(" · ")}</div>
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
            const queue = machineQueue(snapshot, portal.rotations, machine);
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
                      className={`handle tip ${side}`}
                      aria-hidden
                      data-tip="Drag onto a machine to connect"
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
                  {!readOnly && (
                    <>
                      <AlertStickers machineId={machine.id} />
                      {status && status.runningTurns > 0 && (
                        <span className="sticker ok">{status.runningTurns} running</span>
                      )}
                      {status && status.waitingThreads > 0 && (
                        <span className="sticker wait">
                          {status.waitingThreads} {status.waitingThreads === 1 ? "needs" : "need"}{" "}
                          you
                        </span>
                      )}
                      {status?.updateWaiting && <span className="sticker info">update</span>}
                      {!queue.waitingToJoin && queue.count > 0 && (
                        <span className="sticker wait">{queue.count} queued</span>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        {menu && (
          <div
            className="card map-menu"
            role="menu"
            aria-label="Add here"
            style={{
              left: clamp(menu.x, 8, Math.max(8, size.width - 220)),
              top: clamp(menu.y, 8, Math.max(8, size.height - 130)),
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="btn small"
              autoFocus
              onClick={() => {
                setMenu(null);
                portal.open({ _tag: "addMachine", position: toPosition(menu) });
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
                    position: toPosition(menu),
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
      </div>
    </div>
  );
}

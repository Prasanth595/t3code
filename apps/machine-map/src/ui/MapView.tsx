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
  MapPosition,
} from "@t3tools/contracts/machineMap";

import { findArrow } from "../rules/map.ts";
import { NO_SELECTION } from "./route.ts";
import { usePortalContext } from "./context.ts";
import { buildStandings } from "./build.ts";
import { BuildLabel, BuildSticker } from "./BuildLabel.tsx";
import { arrowEndWait, arrowEnds, machineQueue } from "./derive.ts";
import { LEVEL_LABEL, PRESENCE_STICKER, presenceState, spatialArrow, timeAgo } from "./format.ts";
import { ClockIcon, KindIcon } from "./icons.tsx";
import { placePairs, separate, type Box, type Point } from "./layout.ts";
import { settleHeldPositions, type HeldPosition } from "./store.ts";

/** The area machines live in: the map height, and at most 1500 pixels wide, centered. */
const MAX_WIDTH = 1500;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** Pointer moves under this many pixels are a tap, not a drag. */
const TAP_PIXELS = 5;
/** A map narrower than this uses the compact cards. The CSS class `compact` follows it. */
const COMPACT_WIDTH = 640;
/** Card sizes before the page measures them. The first paint already uses the measured sizes. */
const ESTIMATE = {
  wide: { node: { w: 224, h: 120 }, pair: { w: 330, h: 96 } },
  compact: { node: { w: 156, h: 100 }, pair: { w: 130, h: 84 } },
} as const;

interface Size {
  readonly w: number;
  readonly h: number;
}

/**
 * One drag in progress. Pointer moves change it in place and paint on the next frame, so a drag
 * does not render the map on every move.
 */
interface Drag {
  readonly id: MachineId;
  readonly startX: number;
  readonly startY: number;
  /** The position before the drag. */
  readonly from: MapPosition;
  clientX: number;
  clientY: number;
  position: MapPosition;
  moved: boolean;
  /** MM-1104: the machine under the pointer. Dropping here opens the arrow. */
  target: MachineId | null;
}

const pairKey = (a: MachineRecord, b: MachineRecord) => `${a.id}>${b.id}`;
const samePosition = (a: MapPosition, b: MapPosition) => a.x === b.x && a.y === b.y;
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

export function MapView({ map, readOnly }: { map: MachineMapDocument; readOnly: boolean }) {
  const portal = usePortalContext();
  const { snapshot, route, now } = portal;
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  /** The drop target, kept in state so the target card renders its look. */
  const [target, setTarget] = useState<MachineId | null>(null);
  // The state keeps at most one entry per machine. The save answer gives each entry its revision,
  // which the map then reaches, or removes the entry. So the page does not prune the state.
  const [heldState, setHeld] = useState<ReadonlyArray<HeldPosition>>([]);
  const held = settleHeldPositions(heldState, map);

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
    },
    [],
  );

  const compact = size.width < COMPACT_WIDTH;
  const estimate = compact ? ESTIMATE.compact : ESTIMATE.wide;
  const width = Math.min(size.width, MAX_WIDTH);
  const left = (size.width - width) / 2;
  const machines = map.machines;
  const standings = buildStandings(snapshot.presence);
  const selection = route.selection;
  const focus = selection._tag === "machine" ? selection.id : null;
  const focusMachine = machines.find((m) => m.id === focus);
  /** No access either way and nothing special: the pair card takes one short row. */
  const isQuiet = (a: MachineRecord, b: MachineRecord) => {
    const ab = findArrow(map, a.id, b.id);
    const ba = findArrow(map, b.id, a.id);
    return [ab, ba].every(
      (arrow) => arrow.level === "none" && !arrow.agentTools && !arrow.expiresAt,
    );
  };
  // A phone map has no room for every card. Quiet pairs keep their dashed line and show their
  // card only for the focused machine. The Table view lists every arrow.
  const pairs: Array<[MachineRecord, MachineRecord]> = [];
  for (let i = 0; i < machines.length; i++) {
    for (let j = i + 1; j < machines.length; j++) {
      const a = machines[i];
      const b = machines[j];
      if (a && b) pairs.push([a, b]);
    }
  }
  const cardPairs = pairs.filter(
    ([a, b]) => !compact || focus === a.id || focus === b.id || !isQuiet(a, b),
  );

  const position = (m: MachineRecord): MapPosition =>
    held.find((h) => h.machineId === m.id)?.position ?? m.position;
  const toPixels = (p: MapPosition): Point => ({ x: left + p.x * width, y: p.y * size.height });
  const toPosition = (p: Point): MapPosition => ({
    x: clamp((p.x - left) / width, 0.02, 0.98),
    y: clamp(p.y / size.height, 0.02, 0.98),
  });
  const nodeBox = (m: MachineRecord, p: Point): Box => ({
    ...p,
    ...(sizes[`node:${m.id}`] ?? estimate.node),
  });

  /** The machines where the page shows them: saved places, pushed apart (see `layout.ts`). */
  const nodes = separate(
    machines.map((m) => nodeBox(m, toPixels(position(m)))),
    size.width,
    size.height,
  );

  /**
   * Where each card goes. During a drag the dragged machine follows the pointer and the other
   * machines stay. Pair cards then move out of its way.
   */
  const layout = (dragged: { readonly id: MachineId; readonly at: MapPosition } | null) => {
    const boxes = machines.map((m, i) => {
      const settled = nodes[i] ?? nodeBox(m, toPixels(m.position));
      return m.id === dragged?.id ? nodeBox(m, toPixels(dragged.at)) : settled;
    });
    const at = new Map(
      machines.map((m, i) => [m.id, boxes[i] ?? nodeBox(m, toPixels(m.position))]),
    );
    const spots = placePairs(
      cardPairs.map(([a, b]) => ({
        a: at.get(a.id) ?? toPixels(a.position),
        b: at.get(b.id) ?? toPixels(b.position),
        ...(sizes[`pair:${pairKey(a, b)}`] ?? estimate.pair),
      })),
      boxes,
      size.width,
      size.height,
    );
    return { at, spots };
  };
  const shown = layout(null);
  const centerOf = (m: MachineRecord): Point => shown.at.get(m.id) ?? toPixels(position(m));

  /** Writes the place of the dragged machine, every line and every pair card straight to the page. */
  const paint = (id: MachineId, p: MapPosition) => {
    const root = ref.current;
    if (!root) return;
    const { at, spots } = layout({ id, at: p });
    const node = root.querySelector<HTMLElement>(`.node[data-machine-id="${CSS.escape(id)}"]`);
    const q = at.get(id);
    if (node && q) {
      node.style.left = `${q.x}px`;
      node.style.top = `${q.y}px`;
      // The dragged card rides above every other card, also above the drop target.
      node.classList.toggle("dragging", drag.current?.id === id);
    }
    const spotOf = new Map(cardPairs.map((pair, i) => [pairKey(...pair), spots[i]]));
    for (const [a, b] of pairs) {
      const pa = at.get(a.id);
      const pb = at.get(b.id);
      const spot = spotOf.get(pairKey(a, b));
      const key = CSS.escape(pairKey(a, b));
      const line = root.querySelector<SVGLineElement>(`line[data-pair="${key}"]`);
      if (line && pa && pb) {
        line.setAttribute("x1", String(pa.x));
        line.setAttribute("y1", String(pa.y));
        line.setAttribute("x2", String(pb.x));
        line.setAttribute("y2", String(pb.y));
      }
      const card = root.querySelector<HTMLElement>(`.pair[data-pair="${key}"]`);
      if (card && spot) {
        card.style.left = `${spot.x}px`;
        card.style.top = `${spot.y}px`;
      }
    }
  };

  /** Moves the drag to the last pointer. Runs at most once per frame. */
  const step = () => {
    const current = drag.current;
    const rect = ref.current?.getBoundingClientRect();
    if (!current || !rect || width === 0) return;
    const { clientX, clientY } = current;
    current.moved ||= Math.hypot(clientX - current.startX, clientY - current.startY) > TAP_PIXELS;
    if (!current.moved) return;
    current.position = toPosition({ x: clientX - rect.left, y: clientY - rect.top });
    const under = document
      .elementsFromPoint(clientX, clientY)
      .map((element) => element.closest<HTMLElement>("[data-machine-id]")?.dataset.machineId)
      .find((id) => id !== undefined && id !== current.id);
    const nextTarget = machines.find((m) => m.id === under)?.id ?? null;
    if (nextTarget !== current.target) {
      current.target = nextTarget;
      setTarget(nextTarget);
    }
    paint(current.id, current.position);
  };
  // The frame callback runs the newest step, so it paints with the newest map and size.
  const latestStep = useRef(step);
  useLayoutEffect(() => {
    latestStep.current = step;
    // A render during a drag, for example for a revision from another page, writes the saved
    // place. Put the dragged machine back under the pointer before the browser paints.
    const current = drag.current;
    if (current?.moved) paint(current.id, current.position);
  });

  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>, machine: MachineRecord) => {
    if (readOnly || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const from = toPosition(centerOf(machine));
    drag.current = {
      id: machine.id,
      startX: event.clientX,
      startY: event.clientY,
      from,
      clientX: event.clientX,
      clientY: event.clientY,
      position: from,
      moved: false,
      target: null,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    current.clientX = event.clientX;
    current.clientY = event.clientY;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      latestStep.current();
    });
  };

  /** Ends the drag and paints the place that the next render shows. */
  const endDrag = (event: PointerEvent<HTMLDivElement>): Drag | null => {
    const current = drag.current;
    if (!current) return null;
    current.clientX = event.clientX;
    current.clientY = event.clientY;
    cancelFrame();
    step();
    drag.current = null;
    setTarget(null);
    return current;
  };

  const toggle = (machine: MachineRecord) =>
    portal.select(focus === machine.id ? NO_SELECTION : { _tag: "machine", id: machine.id });

  /** A dropped machine settles beside the others, not on top of one. The others stay. */
  const settle = (id: MachineId, p: MapPosition): MapPosition => {
    const index = machines.findIndex((m) => m.id === id);
    const machine = machines[index];
    if (!machine) return p;
    const boxes = machines.map((m, i) =>
      i === index ? nodeBox(m, toPixels(p)) : (nodes[i] ?? nodeBox(m, toPixels(m.position))),
    );
    const fixed = new Set(machines.map((_, i) => i).filter((i) => i !== index));
    const box = separate(boxes, size.width, size.height, fixed)[index];
    return box ? toPosition(box) : p;
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>, machine: MachineRecord) => {
    if (readOnly) {
      portal.select({ _tag: "machine", id: machine.id });
      return;
    }
    const finished = endDrag(event);
    if (!finished || !finished.moved) {
      toggle(machine);
      return;
    }
    if (finished.target) {
      paint(machine.id, finished.from);
      portal.select({ _tag: "arrow", from: machine.id, to: finished.target });
      return;
    }
    const settled = settle(machine.id, finished.position);
    paint(machine.id, settled);
    if (samePosition(settled, finished.from)) return;
    const hold: HeldPosition = { machineId: machine.id, position: settled, revision: null };
    setHeld((current) => [...current.filter((h) => h.machineId !== machine.id), hold]);
    portal
      .submit(
        `Moved ${machine.name}`,
        [{ _tag: "putMachine", machine: { ...machine, position: settled } }],
        { quiet: true },
      )
      .then((outcome) =>
        setHeld((current) =>
          outcome._tag === "applied"
            ? current.map((h) => (h === hold ? { ...h, revision: outcome.revision } : h))
            : // A held draft shows through the map. A proposal or a failure shows the saved place.
              current.filter((h) => h !== hold),
        ),
      );
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    const finished = endDrag(event);
    if (finished?.moved) paint(finished.id, finished.from);
  };

  /** MM-1103: a tap on the empty map ends the focus. */
  const onMapClick = (event: MouseEvent<HTMLDivElement>) => {
    const tapped = event.target;
    const empty =
      tapped === event.currentTarget || (tapped instanceof Element && tapped.tagName === "svg");
    if (empty && selection._tag !== "none") portal.select(NO_SELECTION);
  };

  /** The wait of each arrow end in words, or null when both ends applied it (MM-602, MM-604). */
  const waitOf = (from: MachineRecord, to: MachineRecord, queuedOnly: boolean): Array<string> => {
    if (readOnly) return [];
    const ends = arrowEnds(snapshot, from.id, to.id);
    return [[ends.from, from] as const, [ends.to, to] as const].flatMap(([end, machine]) => {
      const text = queuedOnly && end === "waitingToJoin" ? null : arrowEndWait(end, machine);
      return text === null ? [] : [text];
    });
  };

  const dirRow = (from: MachineRecord, to: MachineRecord, waits: ReadonlyArray<string>) => {
    const arrow = findArrow(map, from.id, to.id);
    const direction = spatialArrow(centerOf(from), centerOf(to));
    const [first, second] = direction.first === "from" ? [from, to] : [to, from];
    const on = selection._tag === "arrow" && selection.from === from.id && selection.to === to.id;
    const wait = waits.map(sentence).join(". ");
    return (
      <button
        type="button"
        className={`dir${on ? " on" : ""}`}
        aria-label={`${from.name} can use ${to.name}: ${LEVEL_LABEL[arrow.level]}${wait ? `. ${wait}` : ""}`}
        onClick={() => portal.select({ _tag: "arrow", from: from.id, to: to.id })}
      >
        <span className="who">
          <span className="nm">{first.name}</span>
          <b className="arrow">{direction.glyph}</b>
          <span className="nm">{second.name}</span>
        </span>
        <span className="actions">
          {wait && <ClockIcon label={wait} />}
          {arrow.expiresAt && <span className="sticker warn flat">temp</span>}
          {arrow.agentTools && <span className="sticker accent flat">tools</span>}
          <span className={`sticker lvl-${arrow.level}`}>{LEVEL_LABEL[arrow.level]}</span>
        </span>
      </button>
    );
  };

  /** A pair with no access either way and nothing special takes one short row. */
  const quietRow = (a: MachineRecord, b: MachineRecord, waits: ReadonlyArray<string>) => {
    const direction = spatialArrow(centerOf(a), centerOf(b));
    const [first, second] = direction.first === "from" ? [a, b] : [b, a];
    const glyph = direction.glyph === "→" || direction.glyph === "←" ? "↔" : "↕";
    const on =
      selection._tag === "arrow" &&
      ((selection.from === a.id && selection.to === b.id) ||
        (selection.from === b.id && selection.to === a.id));
    const wait = waits.map(sentence).join(". ");
    return (
      <button
        type="button"
        className={`dir${on ? " on" : ""}`}
        aria-label={`${a.name} and ${b.name}: no access either way${wait ? `. ${wait}` : ""}`}
        onClick={() => portal.select({ _tag: "arrow", from: a.id, to: b.id })}
      >
        <span className="who">
          <span className="nm">{first.name}</span>
          <b className="arrow">{glyph}</b>
          <span className="nm">{second.name}</span>
        </span>
        <span className="actions">
          {wait && <ClockIcon label={wait} />}
          <span className="sticker lvl-none flat">{LEVEL_LABEL.none}</span>
        </span>
      </button>
    );
  };

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
              Tap a machine to focus it.
              <span className="wide-only"> Drag a machine onto another to open their arrow.</span>
            </span>
          )}
        </div>
      )}
      <div
        className={`card map${compact ? " compact" : ""}${focus ? " focused" : ""}`}
        ref={ref}
        onClick={onMapClick}
      >
        <svg aria-hidden>
          {pairs.map(([a, b]) => {
            const pa = centerOf(a);
            const pb = centerOf(b);
            const touches = focus === a.id || focus === b.id;
            const empty =
              findArrow(map, a.id, b.id).level === "none" &&
              findArrow(map, b.id, a.id).level === "none";
            return (
              <line
                key={pairKey(a, b)}
                data-pair={pairKey(a, b)}
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                className={[empty && "empty", focus && (touches ? "hot" : "dim")]
                  .filter(Boolean)
                  .join(" ")}
              />
            );
          })}
        </svg>
        {size.width > 0 &&
          cardPairs.map(([a, b], i) => {
            const spot = shown.spots[i] ?? { x: 0, y: 0 };
            const dim = focus !== null && focus !== a.id && focus !== b.id;
            const quiet = isQuiet(a, b);
            // A quiet pair skips "waiting to join": a machine that never joined has no access to lose.
            const waitsAB = waitOf(a, b, quiet);
            const waitsBA = waitOf(b, a, quiet);
            // Each machine that did not apply a direction, named once under the rows.
            const waits = [...new Set([...waitsAB, ...waitsBA])];
            return (
              <div
                key={`pair:${pairKey(a, b)}`}
                data-pair={pairKey(a, b)}
                data-size-key={`pair:${pairKey(a, b)}`}
                className={`card pair${dim ? " dim" : ""}${quiet ? " quiet" : ""}`}
                style={{ left: spot.x, top: spot.y }}
              >
                {quiet ? (
                  quietRow(a, b, waits)
                ) : (
                  <>
                    {dirRow(a, b, waitsAB)}
                    {dirRow(b, a, waitsBA)}
                    {waits.length > 0 && (
                      <div className="pair-wait">{waits.map(sentence).join(" · ")}</div>
                    )}
                  </>
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
            const sub =
              state === "waiting" ? (
                "Waiting to join"
              ) : state === "offline" ? (
                `Seen ${timeAgo(presence?.lastSeenAt ?? null, now)}`
              ) : status ? (
                <BuildLabel status={status} />
              ) : (
                (machine.hostname ?? "No status yet")
              );
            return (
              <div
                key={machine.id}
                data-machine-id={machine.id}
                data-size-key={`node:${machine.id}`}
                role="button"
                tabIndex={0}
                aria-pressed={on}
                aria-label={`${machine.name}, ${state}`}
                className={`card node${on ? " on" : ""}${dropTarget ? " target" : ""}${readOnly ? " readonly" : ""}`}
                style={{ left: p.x, top: p.y }}
                onPointerDown={(event) => onPointerDown(event, machine)}
                onPointerMove={onPointerMove}
                onPointerUp={(event) => onPointerUp(event, machine)}
                onPointerCancel={onPointerCancel}
                onKeyDown={onPressKey(() => toggle(machine))}
              >
                <span className={`sticker state ${PRESENCE_STICKER[state]}`}>{state}</span>
                <div className="name">
                  <span className="icon">
                    <KindIcon kind={machine.kind} />
                  </span>
                  <span className="label">
                    {machine.name}
                    <span className="sub">{sub}</span>
                  </span>
                </div>
                <div className="tags">
                  <BuildSticker standing={standings.get(machine.id)} />
                  {!readOnly && (
                    <>
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

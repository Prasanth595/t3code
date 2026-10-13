import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type {
  MachineId,
  MachineMapDocument,
  MachineRecord,
  MapPosition,
} from "@t3tools/contracts/machineMap";

import { findArrow } from "../rules/map.ts";
import { usePortalContext } from "./context.ts";
import { arrowApplied, machineQueue } from "./derive.ts";
import { hasJoined, LEVEL_LABEL, presenceText, spatialArrow } from "./format.ts";
import { KindIcon } from "./icons.tsx";
import { settleHeldPositions, type HeldPosition } from "./store.ts";

/** The area machines live in: the map height, and at most 1500 pixels wide, centered. */
const MAX_WIDTH = 1500;
/** A machine card never leaves the map. */
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** Pointer moves under this many pixels are a tap, not a drag. */
const TAP_PIXELS = 5;
/** A map narrower than this uses the compact cards. The CSS class `compact` follows it. */
const COMPACT_WIDTH = 640;
/** Half the size of a machine card and of a pair card, so both stay inside the map. */
const HALF = {
  wide: { nodeX: 112, nodeY: 74, pairX: 170 },
  compact: { nodeX: 78, nodeY: 66, pairX: 120 },
} as const;

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

export function MapView({ map, readOnly }: { map: MachineMapDocument; readOnly: boolean }) {
  const portal = usePortalContext();
  const { snapshot, route, now } = portal;
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
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

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const compact = size.width < COMPACT_WIDTH;
  const half = compact ? HALF.compact : HALF.wide;
  const width = Math.min(size.width, MAX_WIDTH);
  const left = (size.width - width) / 2;
  const position = (m: MachineRecord): MapPosition =>
    held.find((h) => h.machineId === m.id)?.position ?? m.position;
  const toPixels = (p: MapPosition) => ({
    x: clamp(left + p.x * width, half.nodeX, size.width - half.nodeX),
    y: clamp(p.y * size.height, half.nodeY, size.height - half.nodeY),
  });
  const at = (m: MachineRecord) => toPixels(position(m));
  const pairCenter = (pa: { x: number; y: number }, pb: { x: number; y: number }) => ({
    left: clamp((pa.x + pb.x) / 2, half.pairX, size.width - half.pairX),
    top: (pa.y + pb.y) / 2,
  });

  const selection = route.selection;
  const focus = selection._tag === "machine" ? selection.id : null;
  const machines = map.machines;
  const pairs: Array<[MachineRecord, MachineRecord]> = [];
  for (let i = 0; i < machines.length; i++) {
    for (let j = i + 1; j < machines.length; j++) {
      const a = machines[i];
      const b = machines[j];
      if (a && b) pairs.push([a, b]);
    }
  }

  /**
   * Writes the place of one machine, its lines and its pair cards straight to the page. The arrow
   * glyphs on the pair cards follow on the render after the drop, not on every move.
   */
  const paint = (id: MachineId, p: MapPosition) => {
    const root = ref.current;
    if (!root) return;
    const pixels = (m: MachineRecord) => (m.id === id ? toPixels(p) : at(m));
    const node = root.querySelector<HTMLElement>(`.node[data-machine-id="${CSS.escape(id)}"]`);
    if (node) {
      const q = toPixels(p);
      node.style.left = `${q.x}px`;
      node.style.top = `${q.y}px`;
    }
    for (const [a, b] of pairs) {
      if (a.id !== id && b.id !== id) continue;
      const pa = pixels(a);
      const pb = pixels(b);
      const key = CSS.escape(pairKey(a, b));
      const line = root.querySelector<SVGLineElement>(`line[data-pair="${key}"]`);
      line?.setAttribute("x1", String(pa.x));
      line?.setAttribute("y1", String(pa.y));
      line?.setAttribute("x2", String(pb.x));
      line?.setAttribute("y2", String(pb.y));
      const card = root.querySelector<HTMLElement>(`.pair[data-pair="${key}"]`);
      if (card) {
        const center = pairCenter(pa, pb);
        card.style.left = `${center.left}px`;
        card.style.top = `${center.top}px`;
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
    current.position = {
      x: clamp((clientX - rect.left - left) / width, 0.08, 0.92),
      y: clamp((clientY - rect.top) / size.height, 0.08, 0.92),
    };
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
    if (readOnly) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const from = position(machine);
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

  const onPointerUp = (event: PointerEvent<HTMLDivElement>, machine: MachineRecord) => {
    if (readOnly) {
      portal.select({ _tag: "machine", id: machine.id });
      return;
    }
    const finished = endDrag(event);
    if (!finished || !finished.moved) {
      portal.select({ _tag: "machine", id: machine.id });
      return;
    }
    if (finished.target || samePosition(finished.position, finished.from)) {
      paint(machine.id, finished.from);
      if (finished.target) {
        portal.select({ _tag: "arrow", from: machine.id, to: finished.target });
      }
      return;
    }
    const hold: HeldPosition = {
      machineId: machine.id,
      position: finished.position,
      revision: null,
    };
    setHeld((current) => [...current.filter((h) => h.machineId !== machine.id), hold]);
    portal
      .submit(`Moved ${machine.name}`, [
        { _tag: "putMachine", machine: { ...machine, position: finished.position } },
      ])
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

  const dirRow = (from: MachineRecord, to: MachineRecord) => {
    const arrow = findArrow(map, from.id, to.id);
    const direction = spatialArrow(position(from), position(to));
    const [first, second] = direction.first === "from" ? [from, to] : [to, from];
    const on = selection._tag === "arrow" && selection.from === from.id && selection.to === to.id;
    const applied = arrowApplied(snapshot, from.id, to.id);
    const pendingEnds = [...(applied.from ? [] : [from]), ...(applied.to ? [] : [to])];
    const joining = pendingEnds.filter((m) => !hasJoined(snapshot.presence[m.id]));
    const wait =
      pendingEnds.length > joining.length
        ? "queued"
        : joining.length > 0
          ? `waiting for ${joining.map((m) => m.name).join(" and ")} to join`
          : null;
    return (
      <button
        type="button"
        className={`dir${on ? " on" : ""}`}
        onClick={() => portal.select({ _tag: "arrow", from: from.id, to: to.id })}
      >
        <span>
          {first.name}
          <b className="arrow">{direction.glyph}</b>
          {second.name}
        </span>
        <span className="actions">
          {!readOnly && wait && <span className="sticker wait flat">{wait}</span>}
          {arrow.expiresAt && <span className="sticker warn flat">temp</span>}
          {arrow.agentTools && <span className="sticker accent flat">tools</span>}
          <span className={`sticker lvl-${arrow.level}`}>{LEVEL_LABEL[arrow.level]}</span>
        </span>
      </button>
    );
  };

  return (
    <div className={`card map${compact ? " compact" : ""}`} ref={ref}>
      <svg aria-hidden>
        {pairs.map(([a, b]) => {
          const pa = at(a);
          const pb = at(b);
          const dim = focus !== null && focus !== a.id && focus !== b.id;
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
              className={`${empty ? "empty " : ""}${dim ? "dim" : ""}`}
            />
          );
        })}
      </svg>
      {size.width > 0 &&
        pairs.map(([a, b]) => {
          const pa = at(a);
          const pb = at(b);
          const dim = focus !== null && focus !== a.id && focus !== b.id;
          return (
            <div
              key={`pair:${pairKey(a, b)}`}
              data-pair={pairKey(a, b)}
              className={`card pair${dim ? " dim" : ""}`}
              style={pairCenter(pa, pb)}
            >
              {dirRow(a, b)}
              {dirRow(b, a)}
            </div>
          );
        })}
      {size.width > 0 &&
        machines.map((machine) => {
          const p = at(machine);
          const presence = snapshot.presence[machine.id];
          const state = presenceText(presence, now);
          const status = presence?.status ?? null;
          const queue = machineQueue(snapshot, portal.rotations, machine);
          const on = focus === machine.id;
          const dropTarget = target === machine.id;
          return (
            <div
              key={machine.id}
              data-machine-id={machine.id}
              className={`card node${on ? " on" : ""}${dropTarget ? " target" : ""}${readOnly ? " readonly" : ""}`}
              style={{ left: p.x, top: p.y }}
              onPointerDown={(event) => onPointerDown(event, machine)}
              onPointerMove={onPointerMove}
              onPointerUp={(event) => onPointerUp(event, machine)}
              onPointerCancel={onPointerCancel}
            >
              <span
                className={`sticker state ${state === "online" ? "ok" : state === "waiting" ? "wait" : ""}`}
              >
                {state}
              </span>
              <div className="name">
                <span className="icon">
                  <KindIcon kind={machine.kind} />
                </span>
                <span className="label">
                  {machine.name}
                  <span className="sub">
                    {status?.build ?? machine.hostname ?? "no status yet"}
                  </span>
                </span>
              </div>
              {!readOnly && (
                <div className="tags">
                  {status && status.runningTurns > 0 && (
                    <span className="sticker ok">{status.runningTurns} running</span>
                  )}
                  {status && status.waitingThreads > 0 && (
                    <span className="sticker wait">{status.waitingThreads} waits</span>
                  )}
                  {status?.updateWaiting && <span className="sticker info">update</span>}
                  {queue.waitingToJoin ? (
                    <span className="sticker wait">waiting to join</span>
                  ) : (
                    queue.count > 0 && <span className="sticker wait">{queue.count} queued</span>
                  )}
                </div>
              )}
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
  );
}

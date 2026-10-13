import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { MachineId, MachineMapDocument, MachineRecord } from "@t3tools/contracts/machineMap";

import { findArrow } from "../rules/map.ts";
import { usePortalContext } from "./context.ts";
import { arrowApplied, machineQueue } from "./derive.ts";
import { LEVEL_LABEL, presenceText, spatialArrow } from "./format.ts";
import { KindIcon } from "./icons.tsx";

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

interface Drag {
  readonly id: MachineId;
  readonly startX: number;
  readonly startY: number;
  readonly x: number;
  readonly y: number;
  readonly moved: boolean;
  /** MM-1104: the machine under the pointer. Dropping here opens the arrow. */
  readonly target: MachineId | null;
}

export function MapView({ map, readOnly }: { map: MachineMapDocument; readOnly: boolean }) {
  const portal = usePortalContext();
  const { snapshot, route, now } = portal;
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const compact = size.width < COMPACT_WIDTH;
  const half = compact ? HALF.compact : HALF.wide;
  const width = Math.min(size.width, MAX_WIDTH);
  const left = (size.width - width) / 2;
  const position = (m: MachineRecord) =>
    drag?.id === m.id ? { x: drag.x, y: drag.y } : m.position;
  const at = (m: MachineRecord) => ({
    x: clamp(left + position(m).x * width, half.nodeX, size.width - half.nodeX),
    y: clamp(position(m).y * size.height, half.nodeY, size.height - half.nodeY),
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

  const onPointerDown = (event: PointerEvent<HTMLDivElement>, machine: MachineRecord) => {
    if (readOnly) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      id: machine.id,
      startX: event.clientX,
      startY: event.clientY,
      x: machine.position.x,
      y: machine.position.y,
      moved: false,
      target: null,
    });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!drag || !rect || width === 0) return;
    const moved =
      drag.moved ||
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > TAP_PIXELS;
    const under = document
      .elementsFromPoint(event.clientX, event.clientY)
      .map((element) => element.closest<HTMLElement>("[data-machine-id]")?.dataset.machineId)
      .find((id) => id !== undefined && id !== drag.id);
    setDrag({
      ...drag,
      moved,
      x: clamp((event.clientX - rect.left - left) / width, 0.08, 0.92),
      y: clamp((event.clientY - rect.top) / size.height, 0.08, 0.92),
      target: machines.find((m) => m.id === under)?.id ?? null,
    });
  };

  const onPointerUp = (machine: MachineRecord) => {
    if (readOnly) {
      portal.select({ _tag: "machine", id: machine.id });
      return;
    }
    const finished = drag;
    setDrag(null);
    if (!finished || !finished.moved) {
      portal.select({ _tag: "machine", id: machine.id });
    } else if (finished.target) {
      portal.select({ _tag: "arrow", from: machine.id, to: finished.target });
    } else {
      portal.submit(`Moved ${machine.name}`, [
        { _tag: "putMachine", machine: { ...machine, position: { x: finished.x, y: finished.y } } },
      ]);
    }
  };

  const dirRow = (from: MachineRecord, to: MachineRecord) => {
    const arrow = findArrow(map, from.id, to.id);
    const direction = spatialArrow(position(from), position(to));
    const [first, second] = direction.first === "from" ? [from, to] : [to, from];
    const on = selection._tag === "arrow" && selection.from === from.id && selection.to === to.id;
    const applied = arrowApplied(snapshot, from.id, to.id);
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
          {!readOnly && (!applied.from || !applied.to) && (
            <span className="sticker wait flat">queued</span>
          )}
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
              key={`${a.id}>${b.id}`}
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
              key={`pair:${a.id}>${b.id}`}
              className={`card pair${dim ? " dim" : ""}`}
              style={{
                left: clamp((pa.x + pb.x) / 2, half.pairX, size.width - half.pairX),
                top: (pa.y + pb.y) / 2,
              }}
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
          const target = drag?.target === machine.id;
          return (
            <div
              key={machine.id}
              data-machine-id={machine.id}
              className={`card node${on ? " on" : ""}${target ? " target" : ""}${readOnly ? " readonly" : ""}`}
              style={{ left: p.x, top: p.y }}
              onPointerDown={(event) => onPointerDown(event, machine)}
              onPointerMove={onPointerMove}
              onPointerUp={() => onPointerUp(machine)}
              onPointerCancel={() => setDrag(null)}
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
                  {queue.count > 0 && <span className="sticker wait">{queue.count} queued</span>}
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

/**
 * MM-106: the page keeps one WebSocket to the portal and folds its events into one state.
 */
import { useEffect, useState } from "react";
import * as Schema from "effect/Schema";
import {
  MachineId,
  PortalEvent,
  type MachineMapDocument,
  type MapPosition,
  type PortalSnapshot,
} from "@t3tools/contracts/machineMap";
import type { ResourcesOverview } from "@t3tools/contracts/machineMapResources";

import {
  HealthEvent,
  PauseEvent,
  ResourceSampleEvent,
  type PauseState,
  type PendingRotation,
  type RotationsEvent,
} from "../api.ts";

export interface PortalState {
  readonly snapshot: PortalSnapshot | null;
  readonly rotations: ReadonlyArray<PendingRotation>;
  /** MM-713: null when nothing is paused. */
  readonly pause: PauseState | null;
  /** MM-1506: the latest samples, thresholds and alerts. */
  readonly health: ResourcesOverview;
}

export type PageEvent =
  | PortalEvent
  | RotationsEvent
  | PauseEvent
  | HealthEvent
  | ResourceSampleEvent;

export const EMPTY_HEALTH: ResourcesOverview = { latest: {}, alerts: [], thresholds: {} };

export const INITIAL_STATE: PortalState = {
  snapshot: null,
  rotations: [],
  pause: null,
  health: EMPTY_HEALTH,
};

export function reduce(state: PortalState, event: PageEvent): PortalState {
  if (event._tag === "snapshot") return { ...state, snapshot: event.snapshot };
  if (event._tag === "rotations") return { ...state, rotations: event.rotations };
  if (event._tag === "pause") return { ...state, pause: event.pause };
  if (event._tag === "health") return { ...state, health: event.health };
  if (event._tag === "resourceSample") {
    const latest = { ...state.health.latest, [event.machineId]: event.sample };
    return { ...state, health: { ...state.health, latest } };
  }
  const snapshot = state.snapshot;
  // Events before the first snapshot cannot happen: the portal sends the snapshot first.
  if (!snapshot) return state;
  switch (event._tag) {
    case "revision":
      return {
        ...state,
        snapshot: {
          ...snapshot,
          map: event.map,
          history: [
            event.revision,
            ...snapshot.history.filter((r) => r.revision !== event.revision.revision),
          ],
        },
      };
    case "presence":
      return {
        ...state,
        snapshot: {
          ...snapshot,
          presence: { ...snapshot.presence, [event.machineId]: event.presence },
        },
      };
    case "reportedSettings":
      return {
        ...state,
        snapshot: {
          ...snapshot,
          reportedSettings: { ...snapshot.reportedSettings, [event.machineId]: event.settings },
        },
      };
    case "command": {
      const others = snapshot.commands.filter((c) => c.id !== event.command.id);
      return { ...state, snapshot: { ...snapshot, commands: [event.command, ...others] } };
    }
    case "proposals":
      return { ...state, snapshot: { ...snapshot, proposals: event.proposals } };
  }
}

/**
 * A machine position that the page shows before the map holds it: a dropped machine stays where
 * the owner let go while the save runs.
 */
export interface HeldPosition {
  readonly machineId: MachineId;
  readonly position: MapPosition;
  /** The revision that saved the position. Null until the portal answers. */
  readonly revision: number | null;
}

/**
 * Drops the held positions that the map caught up with: the map has the same position, or the map
 * reached the revision that saved it. Returns the same array when nothing changed.
 */
export function settleHeldPositions(
  held: ReadonlyArray<HeldPosition>,
  map: MachineMapDocument,
): ReadonlyArray<HeldPosition> {
  const open = held.filter((h) => {
    const machine = map.machines.find((m) => m.id === h.machineId);
    if (!machine) return false;
    if (h.revision !== null && map.revision >= h.revision) return false;
    return machine.position.x !== h.position.x || machine.position.y !== h.position.y;
  });
  return open.length === held.length ? held : open;
}

const RotationsEventSchema = Schema.TaggedStruct("rotations", {
  rotations: Schema.Array(
    Schema.Struct({ machineId: MachineId, createdAt: Schema.String, expiresAt: Schema.String }),
  ),
});
const decodeEvent = Schema.decodeUnknownSync(
  Schema.Union([PortalEvent, RotationsEventSchema, PauseEvent, HealthEvent, ResourceSampleEvent]),
);

export type Connection = "connecting" | "live" | "offline";

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

/** Connects, reconnects with backoff, and pings so idle proxies keep the socket open. */
export function usePortal(): { state: PortalState; connection: Connection } {
  const [state, setState] = useState(INITIAL_STATE);
  const [connection, setConnection] = useState<Connection>("connecting");

  useEffect(() => {
    let socket: WebSocket | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let backoff = 1000;

    const open = () => {
      setConnection("connecting");
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const current = new WebSocket(`${scheme}://${location.host}/api/events`);
      socket = current;
      current.addEventListener("open", () => {
        backoff = 1000;
        setConnection("live");
        ping = setInterval(() => current.send("ping"), PING_MS);
      });
      current.addEventListener("message", (message: MessageEvent<unknown>) => {
        if (typeof message.data !== "string" || message.data === "pong") return;
        try {
          const event = decodeEvent(JSON.parse(message.data));
          setState((state) => reduce(state, event));
        } catch (error) {
          console.error("Bad portal event", error);
        }
      });
      current.addEventListener("close", () => {
        clearInterval(ping);
        if (stopped) return;
        setConnection("offline");
        retry = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      });
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(ping);
      socket?.close();
    };
  }, []);

  return { state, connection };
}

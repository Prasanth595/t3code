/**
 * MM-106: the page keeps one WebSocket to the portal and folds its events into one state.
 */
import { useEffect, useState } from "react";
import * as Schema from "effect/Schema";
import { MachineId, PortalEvent, type PortalSnapshot } from "@t3tools/contracts/machineMap";
import type { ResourcesOverview } from "@t3tools/contracts/machineMapResources";

import {
  ClientInvitesEvent,
  EnrolledEvent,
  HealthEvent,
  PauseEvent,
  PendingClientsEvent,
  ResourceSampleEvent,
  type PauseView,
  type ClientInvite,
  type PendingClient,
  type PendingRotation,
  type RotationsEvent,
} from "../api.ts";

export interface PortalState {
  readonly snapshot: PortalSnapshot | null;
  readonly rotations: ReadonlyArray<PendingRotation>;
  /** MM-713: null when nothing is paused. */
  readonly pause: PauseView | null;
  /** MM-1506: the latest samples, thresholds and alerts. */
  readonly health: ResourcesOverview;
  /** MM-212: how many times each machine used a join code while this page was open. */
  readonly joins: Readonly<Record<string, number>>;
  /** MM-906: browser keys that wait for approval or that the owner rejected. Null until the first list. */
  readonly pending: ReadonlyArray<PendingClient> | null;
  /** MM-913: invites of native apps that wait to be used. */
  readonly invites: ReadonlyArray<ClientInvite>;
}

export type PageEvent =
  | PortalEvent
  | RotationsEvent
  | PauseEvent
  | HealthEvent
  | ResourceSampleEvent
  | EnrolledEvent
  | PendingClientsEvent
  | ClientInvitesEvent;

const EMPTY_HEALTH: ResourcesOverview = { latest: {}, alerts: [], thresholds: {} };

export const INITIAL_STATE: PortalState = {
  snapshot: null,
  rotations: [],
  pause: null,
  health: EMPTY_HEALTH,
  joins: {},
  pending: null,
  invites: [],
};

export function reduce(state: PortalState, event: PageEvent): PortalState {
  if (event._tag === "snapshot") return { ...state, snapshot: event.snapshot };
  if (event._tag === "rotations") return { ...state, rotations: event.rotations };
  if (event._tag === "pause") return { ...state, pause: event.pause };
  if (event._tag === "health") return { ...state, health: event.health };
  if (event._tag === "pendingClients") return { ...state, pending: event.pending };
  if (event._tag === "clientInvites") return { ...state, invites: event.invites };
  if (event._tag === "resourceSample") {
    const latest = { ...state.health.latest, [event.machineId]: event.sample };
    return { ...state, health: { ...state.health, latest } };
  }
  if (event._tag === "enrolled") {
    const joins = { ...state.joins, [event.machineId]: (state.joins[event.machineId] ?? 0) + 1 };
    return { ...state, joins };
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
 * A place that the page shows before the map holds it: a dropped card stays where the owner let
 * go while the save runs. `key` names the card, for example `machine:mac`.
 */
export interface Held<T> {
  readonly key: string;
  readonly value: T;
  /** The revision that saved the place. Null until the portal answers. */
  readonly revision: number | null;
}

/**
 * Drops the held places that the map caught up with: the map has the same place, or the map
 * reached the revision that saved it. `saved` returns undefined for a card that is gone.
 * Returns the same array when nothing changed.
 */
export function settleHeld<T>(
  held: ReadonlyArray<Held<T>>,
  mapRevision: number,
  saved: (key: string) => T | undefined,
  same: (a: T, b: T) => boolean,
): ReadonlyArray<Held<T>> {
  const open = held.filter((h) => {
    const current = saved(h.key);
    if (current === undefined) return false;
    if (h.revision !== null && mapRevision >= h.revision) return false;
    return !same(current, h.value);
  });
  return open.length === held.length ? held : open;
}

const RotationsEventSchema = Schema.TaggedStruct("rotations", {
  rotations: Schema.Array(
    Schema.Struct({ machineId: MachineId, createdAt: Schema.String, expiresAt: Schema.String }),
  ),
});
const decodeEvent = Schema.decodeUnknownSync(
  Schema.Union([
    PortalEvent,
    RotationsEventSchema,
    PauseEvent,
    HealthEvent,
    ResourceSampleEvent,
    EnrolledEvent,
    PendingClientsEvent,
    ClientInvitesEvent,
  ]),
);

/** `signed-out`: the Cloudflare Access session ended, so only a new sign-in helps (MM-1804). */
export type Connection = "connecting" | "live" | "offline" | "signed-out";

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * MM-1804: an ended Access session answers every portal path with a redirect to the sign-in.
 * The manifest is a small file that the service worker does not cache, so it makes a cheap probe.
 */
async function sessionEnded(): Promise<boolean> {
  try {
    const response = await fetch("/manifest.webmanifest", {
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
    });
    return response.type === "opaqueredirect" || response.status === 401 || response.status === 403;
  } catch {
    // No network: the page is offline, and the sign-in may still be good.
    return false;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/** How long a reload for a new portal waits before it may run again. */
const RELOAD_GAP_MS = 60_000;
const RELOAD_KEY = "machine-map:reloaded-for-portal";

/**
 * A snapshot that does not decode comes from a newer portal than this page, for example after a
 * deploy changed the map format. The page loads again to get the new bundle, instead of keeping
 * an old map and sending changes in the old format. It reloads at most once a minute, so a real
 * bug in the snapshot does not loop.
 */
function reloadForNewPortal(): void {
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
  if (Date.now() - last < RELOAD_GAP_MS) return;
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  location.reload();
}

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
        let raw: unknown;
        try {
          raw = JSON.parse(message.data);
          const event = decodeEvent(raw);
          setState((state) => reduce(state, event));
        } catch (error) {
          console.error("Bad portal event", error);
          if (isRecord(raw) && raw._tag === "snapshot") reloadForNewPortal();
        }
      });
      current.addEventListener("close", () => {
        clearInterval(ping);
        if (stopped) return;
        void sessionEnded().then((ended) => {
          if (stopped) return;
          // A retry would only meet the sign-in redirect again.
          if (ended) return setConnection("signed-out");
          setConnection("offline");
          retry = setTimeout(open, backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        });
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

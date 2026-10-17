import { useCallback, useSyncExternalStore } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";

import {
  FactoryApiError,
  factoryApi,
  type FactoryRunDetail,
  type FactoryRunRow,
  type FactoryStatus,
} from "./api";

/** How often an open page or badge reads again, while the window shows and the reader is about. */
export const POLL_MS = 30_000;

/**
 * A tick within this of `POLL_MS` since the last read started still reads: the timer that fires a
 * millisecond early would otherwise skip every other poll. Two readers' timers out of step by more
 * than this still cost one read per period, since only the first past the gap reads.
 */
const TICK_SLACK_MS = 1_000;

export interface FactoryResource<T> {
  readonly status: "loading" | "error" | "ready";
  readonly data: T | null;
  readonly error: Error | null;
  readonly refresh: () => void;
}

type Loaded<T> = Omit<FactoryResource<T>, "refresh">;

type Key = "status" | "runs" | "runs:all" | `run:${string}`;

const LOADING: Loaded<never> = { status: "loading", data: null, error: null };

interface Store {
  state: Loaded<unknown>;
  /** The number of the latest read; an answer is applied only while its read is still the latest. */
  issued: number;
  inFlight: boolean;
  /** When the latest read started, so two readers' timers on one key cost one read per POLL_MS. */
  startedAt: number;
  readonly listeners: Set<() => void>;
}

/**
 * One store per key while anyone reads it: one answer every reader sees, and a refresh from one
 * reader (the page, after a control) updates the others (the badge). A poll tick joins a read in
 * flight, so ticks never pile up behind a slow server; a refresh a reader asked for starts a new
 * read whose answer supersedes the one in flight, so what the reader sees after a control always
 * comes from after it. With the last reader gone the store is dropped, so the next reader starts
 * at loading and an answer still in flight is thrown away.
 */
const stores = new Map<Key, Store>();

const load = (key: Key): Promise<unknown> =>
  key === "status"
    ? factoryApi.status()
    : key === "runs" || key === "runs:all"
      ? factoryApi.runs({ all: key === "runs:all" })
      : factoryApi.run(key.slice("run:".length));

const read = (key: Key, store: Store): void => {
  const n = ++store.issued;
  store.inFlight = true;
  store.startedAt = Date.now();
  const settle = (next: Loaded<unknown>) => {
    if (stores.get(key) !== store || n !== store.issued) return;
    store.inFlight = false;
    store.state = next;
    store.listeners.forEach((listener) => listener());
  };
  load(key).then(
    (data) => settle({ status: "ready", data, error: null }),
    (cause: unknown) =>
      settle({
        status: "error",
        data: store.state.data,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      }),
  );
};

/** A read the reader asked for: now, superseding one in flight. */
const refresh = (key: Key): void => {
  const store = stores.get(key);
  if (store !== undefined) read(key, store);
};

/** A poll tick: not while a read is in flight, nor within a period (less slack) of the last start. */
const tick = (key: Key): void => {
  const store = stores.get(key);
  if (store === undefined || store.inFlight) return;
  if (Date.now() - store.startedAt < POLL_MS - TICK_SLACK_MS) return;
  read(key, store);
};

const subscribe = (key: Key, listener: () => void): (() => void) => {
  let store = stores.get(key);
  if (store === undefined) {
    store = { state: LOADING, issued: 0, inFlight: false, startedAt: 0, listeners: new Set() };
    stores.set(key, store);
    read(key, store);
  }
  const added = store;
  added.listeners.add(listener);
  return () => {
    added.listeners.delete(listener);
    if (added.listeners.size === 0 && stores.get(key) === added) stores.delete(key);
  };
};

const snapshot = (key: Key): Loaded<unknown> => stores.get(key)?.state ?? LOADING;

/** For tests: drop every store, so the next reader starts over. */
export function __resetFactoryStoresForTests(): void {
  stores.clear();
}

/**
 * The resource behind `key`: read when its first reader mounts, then on the live-refresh policy
 * (every `POLL_MS` while the window shows and the reader is about, and on coming back to the
 * window), and no more after a 404, which says the server has no factory or no such run. Readers
 * of one key share the store, whose `tick` makes their timers one read per `POLL_MS`. The full
 * runs list is read once and never polled: every run the factory ever made, every half minute,
 * is the cost the recent window exists to avoid.
 */
function useFactoryResource<T>(key: Key): FactoryResource<T> {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(key, listener), [key]),
    useCallback(() => snapshot(key) as Loaded<T>, [key]),
  );
  const tickNow = useCallback(() => tick(key), [key]);
  const refreshNow = useCallback(() => refresh(key), [key]);
  const gone = state.error instanceof FactoryApiError && state.error.status === 404;
  const polled = key !== "runs:all" && !gone;
  useLiveRefresh(tickNow, { key: `factory:${key}`, intervalMs: POLL_MS, enabled: polled });
  return { ...state, refresh: refreshNow };
}

export const useFactoryStatus = (): FactoryResource<FactoryStatus> =>
  useFactoryResource<FactoryStatus>("status");

/** The runs list: the recent window the server lists by default, polled; or every run with `all`, read once. */
export const useFactoryRuns = (
  all = false,
): FactoryResource<{ readonly runs: ReadonlyArray<FactoryRunRow> }> =>
  useFactoryResource(all ? "runs:all" : "runs");

/**
 * False once the status answered 404: this server has no factory (an upstream build), so the
 * sidebar hides the item instead of leading to a page that cannot load. True before any answer.
 */
export function useFactorySupported(): boolean {
  const { error } = useFactoryStatus();
  return !(error instanceof FactoryApiError && error.status === 404);
}

export const useFactoryRun = (id: string): FactoryResource<FactoryRunDetail> =>
  useFactoryResource<FactoryRunDetail>(`run:${id}`);

/** The open attention items, for the sidebar badge: the last count known, 0 before any answer. */
export function useFactoryAttentionCount(): number {
  const { data } = useFactoryStatus();
  return data?.attention.length ?? 0;
}

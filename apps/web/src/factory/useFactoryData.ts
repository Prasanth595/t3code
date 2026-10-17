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

export interface FactoryResource<T> {
  readonly status: "loading" | "error" | "ready";
  readonly data: T | null;
  readonly error: Error | null;
  readonly refresh: () => void;
}

type Loaded<T> = Omit<FactoryResource<T>, "refresh">;

type Key = "status" | "runs" | `run:${string}`;

const LOADING: Loaded<never> = { status: "loading", data: null, error: null };

interface Store {
  state: Loaded<unknown>;
  inFlight: boolean;
  readonly listeners: Set<() => void>;
}

/**
 * One store per key while anyone reads it: one answer every reader sees, and a refresh from one
 * reader (the page, after a control) updates the others (the badge). One read at a time: a refresh
 * during a read joins it, so a poll tick never piles up behind a slow server and a late answer can
 * never overwrite a newer one. With the last reader gone the store is dropped, so the next reader
 * starts at loading and an answer still in flight is thrown away.
 */
const stores = new Map<Key, Store>();

const load = (key: Key): Promise<unknown> =>
  key === "status"
    ? factoryApi.status()
    : key === "runs"
      ? factoryApi.runs()
      : factoryApi.run(key.slice("run:".length));

const refresh = (key: Key): void => {
  const store = stores.get(key);
  if (store === undefined || store.inFlight) return;
  store.inFlight = true;
  const settle = (next: Loaded<unknown>) => {
    store.inFlight = false;
    if (stores.get(key) !== store) return;
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

const subscribe = (key: Key, listener: () => void): (() => void) => {
  let store = stores.get(key);
  if (store === undefined) {
    store = { state: LOADING, inFlight: false, listeners: new Set() };
    stores.set(key, store);
    refresh(key);
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
 * of one key share the store and, through the key, the policy's record of the last read, so two
 * readers do not read twice.
 */
function useFactoryResource<T>(key: Key): FactoryResource<T> {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(key, listener), [key]),
    useCallback(() => snapshot(key) as Loaded<T>, [key]),
  );
  const refreshNow = useCallback(() => refresh(key), [key]);
  const gone = state.error instanceof FactoryApiError && state.error.status === 404;
  useLiveRefresh(refreshNow, { key: `factory:${key}`, intervalMs: POLL_MS, enabled: !gone });
  return { ...state, refresh: refreshNow };
}

export const useFactoryStatus = (): FactoryResource<FactoryStatus> =>
  useFactoryResource<FactoryStatus>("status");

export const useFactoryRuns = (): FactoryResource<{
  readonly runs: ReadonlyArray<FactoryRunRow>;
}> => useFactoryResource("runs");

export const useFactoryRun = (id: string): FactoryResource<FactoryRunDetail> =>
  useFactoryResource<FactoryRunDetail>(`run:${id}`);

/** The open attention items, for the sidebar badge: the last count known, 0 before any answer. */
export function useFactoryAttentionCount(): number {
  const { data } = useFactoryStatus();
  return data?.attention.length ?? 0;
}

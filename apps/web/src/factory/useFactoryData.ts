import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { factoryApi, type FactoryRunDetail, type FactoryRunRow, type FactoryStatus } from "./api";

const POLL_MS = 30_000;

export interface FactoryResource<T> {
  readonly status: "loading" | "error" | "ready";
  readonly data: T | null;
  readonly error: Error | null;
  readonly refresh: () => void;
}

type Loaded<T> = Omit<FactoryResource<T>, "refresh">;

/**
 * Loads on mount and every 30 seconds while mounted. A refresh keeps the last data on screen until
 * the answer lands; an answer that arrives after unmount is dropped. `load` must be stable: a new
 * one starts over, so a caller whose input changes remounts (`key`) to show loading again.
 */
function usePolled<T>(load: () => Promise<T>): FactoryResource<T> {
  const [state, setState] = useState<Loaded<T>>({ status: "loading", data: null, error: null });
  const fetchRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    // Requests are numbered; an answer older than one already applied is dropped.
    let issued = 0;
    let applied = 0;
    const fetchNow = () => {
      const n = ++issued;
      load().then(
        (data) => {
          if (!alive || n < applied) return;
          applied = n;
          setState({ status: "ready", data, error: null });
        },
        (cause: unknown) => {
          if (!alive || n < applied) return;
          applied = n;
          const error = cause instanceof Error ? cause : new Error(String(cause));
          setState((previous) => ({ status: "error", data: previous.data, error }));
        },
      );
    };
    fetchRef.current = fetchNow;
    fetchNow();
    const timer = setInterval(fetchNow, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [load]);

  const refresh = useCallback(() => fetchRef.current(), []);
  return { ...state, refresh };
}

const loadRuns = () => factoryApi.runs();

/**
 * The status is read by the sidebar badge and by the page, so it lives in one module-level store:
 * one timer while anyone is subscribed, one answer every reader sees, and a refresh from the page
 * updates the badge too. With the last reader gone the timer stops and the store starts over.
 */
const LOADING: Loaded<FactoryStatus> = { status: "loading", data: null, error: null };
let statusState: Loaded<FactoryStatus> = LOADING;
let statusTimer: ReturnType<typeof setInterval> | null = null;
// Bumped when the store stops, so an answer to an earlier subscription is dropped.
let statusEpoch = 0;
// Requests are numbered like in `usePolled`; an answer older than one already applied is dropped.
let statusIssued = 0;
let statusApplied = 0;
const statusListeners = new Set<() => void>();

const setStatusState = (next: Loaded<FactoryStatus>) => {
  statusState = next;
  statusListeners.forEach((listener) => listener());
};

const refreshStatus = () => {
  const epoch = statusEpoch;
  const n = ++statusIssued;
  factoryApi.status().then(
    (data) => {
      if (epoch !== statusEpoch || n < statusApplied) return;
      statusApplied = n;
      setStatusState({ status: "ready", data, error: null });
    },
    (cause: unknown) => {
      if (epoch !== statusEpoch || n < statusApplied) return;
      statusApplied = n;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setStatusState({ status: "error", data: statusState.data, error });
    },
  );
};

const stopStatus = () => {
  if (statusTimer !== null) clearInterval(statusTimer);
  statusTimer = null;
  statusEpoch += 1;
  statusIssued = 0;
  statusApplied = 0;
  statusState = LOADING;
};

const subscribeStatus = (listener: () => void) => {
  statusListeners.add(listener);
  if (statusListeners.size === 1) {
    refreshStatus();
    statusTimer = setInterval(refreshStatus, POLL_MS);
  }
  return () => {
    statusListeners.delete(listener);
    if (statusListeners.size === 0) stopStatus();
  };
};

const getStatusState = () => statusState;

/** For tests: drop the shared status store, its timer and its readers. */
export function __resetFactoryStoresForTests() {
  statusListeners.clear();
  stopStatus();
}

export function useFactoryStatus(): FactoryResource<FactoryStatus> {
  const state = useSyncExternalStore(subscribeStatus, getStatusState);
  return { ...state, refresh: refreshStatus };
}

export const useFactoryRuns = (): FactoryResource<{
  readonly runs: ReadonlyArray<FactoryRunRow>;
}> => usePolled(loadRuns);

export const useFactoryRun = (id: string): FactoryResource<FactoryRunDetail> =>
  usePolled(useCallback(() => factoryApi.run(id), [id]));

/** The open attention items, for the sidebar badge: 0 while loading and on any error. */
export function useFactoryAttentionCount(): number {
  const { status, data } = useFactoryStatus();
  return status === "ready" && data !== null ? data.attention.length : 0;
}

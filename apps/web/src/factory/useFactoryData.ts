import { useCallback, useEffect, useRef, useState } from "react";

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
    const fetchNow = () => {
      load().then(
        (data) => {
          if (alive) setState({ status: "ready", data, error: null });
        },
        (cause: unknown) => {
          if (!alive) return;
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

const loadStatus = () => factoryApi.status();
const loadRuns = () => factoryApi.runs();

export const useFactoryStatus = (): FactoryResource<FactoryStatus> => usePolled(loadStatus);

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

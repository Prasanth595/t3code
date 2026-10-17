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
 * Loads on mount and every 30 seconds while mounted. A refresh keeps the last data on screen
 * (`ready`) until the answer lands; an answer that arrives after unmount or after `load` changed
 * is dropped.
 */
function usePolled<T>(load: () => Promise<T>, key: string): FactoryResource<T> {
  const [state, setState] = useState<Loaded<T>>({ status: "loading", data: null, error: null });
  const fetchRef = useRef<() => void>(() => {});
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    setState({ status: "loading", data: null, error: null });
    const fetchNow = () => {
      loadRef.current().then(
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
  }, [key]);

  const refresh = useCallback(() => fetchRef.current(), []);
  return { ...state, refresh };
}

export const useFactoryStatus = (): FactoryResource<FactoryStatus> =>
  usePolled(() => factoryApi.status(), "status");

export const useFactoryRuns = (): FactoryResource<{
  readonly runs: ReadonlyArray<FactoryRunRow>;
}> => usePolled(() => factoryApi.runs(), "runs");

export const useFactoryRun = (id: string): FactoryResource<FactoryRunDetail> =>
  usePolled(() => factoryApi.run(id), `run:${id}`);

/** The open attention items, for the sidebar badge: 0 while loading and on any error. */
export function useFactoryAttentionCount(): number {
  const { status, data } = useFactoryStatus();
  return status === "ready" && data !== null ? data.attention.length : 0;
}

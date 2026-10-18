import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "~/state/environments";

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
  /** When the latest answer landed (0 before any): the pages' age labels move on with a poll. */
  readonly readAt: number;
  readonly refresh: () => void;
}

type Loaded<T> = Omit<FactoryResource<T>, "refresh">;

type Resource = "status" | "runs" | "runs:all" | `run:${string}`;

const LOADING: Loaded<never> = { status: "loading", data: null, error: null, readAt: 0 };

interface Store {
  readonly environmentId: EnvironmentId;
  readonly resource: Resource;
  state: Loaded<unknown>;
  /** The number of the latest read; an answer is applied only while its read is still the latest. */
  issued: number;
  inFlight: boolean;
  /** When the latest read started, so two readers' timers on one key cost one read per POLL_MS. */
  startedAt: number;
  readonly listeners: Set<() => void>;
}

/**
 * One store per environment and resource while anyone reads it: one answer every reader sees, and
 * a refresh from one reader (the page, after a control) updates the others (the badge). A poll
 * tick joins a read in flight, so ticks never pile up behind a slow server; a refresh a reader
 * asked for starts a new read whose answer supersedes the one in flight, so what the reader sees
 * after a control always comes from after it. With the last reader gone the store is dropped, so
 * the next reader starts at loading and an answer still in flight is thrown away. The drop waits a
 * microtask: when a subscription's deps change, React tears down every old subscription before it
 * builds the new ones in one flush, and a store dropped in between would lose its data and its
 * readers' reads to a refetch.
 */
const stores = new Map<string, Store>();

const keyOf = (environmentId: EnvironmentId, resource: Resource): string =>
  `${environmentId} ${resource}`;

const load = ({ environmentId, resource }: Store): Promise<unknown> =>
  resource === "status"
    ? factoryApi.status(environmentId)
    : resource === "runs" || resource === "runs:all"
      ? factoryApi.runs(environmentId, { all: resource === "runs:all" })
      : factoryApi.run(environmentId, resource.slice("run:".length));

const read = (key: string, store: Store): void => {
  const n = ++store.issued;
  store.inFlight = true;
  store.startedAt = Date.now();
  const settle = (next: Loaded<unknown>) => {
    if (stores.get(key) !== store || n !== store.issued) return;
    store.inFlight = false;
    store.state = next;
    store.listeners.forEach((listener) => listener());
  };
  load(store).then(
    (data) => settle({ status: "ready", data, error: null, readAt: Date.now() }),
    (cause: unknown) =>
      settle({
        status: "error",
        data: store.state.data,
        error: cause instanceof Error ? cause : new Error(String(cause)),
        readAt: Date.now(),
      }),
  );
};

/** A read the reader asked for: now, superseding one in flight. */
const refresh = (key: string): void => {
  const store = stores.get(key);
  if (store !== undefined) read(key, store);
};

/**
 * A poll tick: not while a read is in flight, nor within a period (less slack) of the last start,
 * and not after a 404, which says the server has no factory or no such run.
 */
const tick = (key: string): void => {
  const store = stores.get(key);
  if (store === undefined || store.inFlight) return;
  if (store.state.error instanceof FactoryApiError && store.state.error.status === 404) return;
  if (Date.now() - store.startedAt < POLL_MS - TICK_SLACK_MS) return;
  read(key, store);
};

const subscribe = (
  environmentId: EnvironmentId,
  resource: Resource,
  listener: () => void,
): (() => void) => {
  const key = keyOf(environmentId, resource);
  let store = stores.get(key);
  if (store === undefined) {
    store = {
      environmentId,
      resource,
      state: LOADING,
      issued: 0,
      inFlight: false,
      startedAt: 0,
      listeners: new Set(),
    };
    stores.set(key, store);
    read(key, store);
  }
  const added = store;
  added.listeners.add(listener);
  return () => {
    added.listeners.delete(listener);
    queueMicrotask(() => {
      if (added.listeners.size === 0 && stores.get(key) === added) stores.delete(key);
    });
  };
};

const snapshot = (key: string): Loaded<unknown> => stores.get(key)?.state ?? LOADING;

/** For tests: drop every store, so the next reader starts over. */
export function __resetFactoryStoresForTests(): void {
  stores.clear();
}

const noUnsubscribe = () => {};

/**
 * The resource of one environment: read when its first reader mounts, then on the live-refresh
 * policy (every `POLL_MS` while the window shows and the reader is about, and on coming back to the
 * window), and no more after a 404. Readers of one key share the store, whose `tick` makes their
 * timers one read per `POLL_MS`. The full runs list is read once and never polled: every run the
 * factory ever made, every half minute, is the cost the recent window exists to avoid. Without an
 * environment there is nothing to read: the loading state, and a refresh that does nothing.
 */
function useFactoryResource<T>(
  environmentId: EnvironmentId | null,
  resource: Resource,
): FactoryResource<T> {
  const key = environmentId === null ? null : keyOf(environmentId, resource);
  const state = useSyncExternalStore(
    (listener: () => void) =>
      environmentId === null ? noUnsubscribe : subscribe(environmentId, resource, listener),
    () => (key === null ? LOADING : snapshot(key)) as Loaded<T>,
  );
  const tickNow = () => {
    if (key !== null) tick(key);
  };
  const refreshNow = () => {
    if (key !== null) refresh(key);
  };
  useLiveRefresh(tickNow, {
    key: `factory:${environmentId}:${resource}`,
    intervalMs: POLL_MS,
    enabled: key !== null && resource !== "runs:all",
  });
  return { ...state, refresh: refreshNow };
}

export const useFactoryStatus = (
  environmentId: EnvironmentId | null,
): FactoryResource<FactoryStatus> => useFactoryResource<FactoryStatus>(environmentId, "status");

/** The runs list: the recent window the server lists by default, polled; or every run with `all`, read once. */
export const useFactoryRuns = (
  environmentId: EnvironmentId | null,
  all = false,
): FactoryResource<{ readonly runs: ReadonlyArray<FactoryRunRow> }> =>
  useFactoryResource(environmentId, all ? "runs:all" : "runs");

export const useFactoryRun = (
  environmentId: EnvironmentId | null,
  id: string,
): FactoryResource<FactoryRunDetail> =>
  useFactoryResource<FactoryRunDetail>(environmentId, `run:${id}`);

/** The first candidate that runs; null while an earlier one has not answered; else the primary. */
export function pickFactoryEnvironment(
  candidates: ReadonlyArray<EnvironmentId>,
  primary: EnvironmentId | null,
  statusOf: (id: EnvironmentId) => Loaded<FactoryStatus>,
): EnvironmentId | null {
  for (const id of candidates) {
    const { status, data } = statusOf(id);
    if (data?.state === "running") return id;
    if (status === "loading") return null;
  }
  return primary;
}

/**
 * The environment whose factory the pages show: the first connected environment whose status says
 * `running`, the primary first; with none running, the primary, whose status then says why it is
 * idle. Every candidate's status is read and polled here, through the same stores the pages' own
 * status hooks use, so choosing costs no read beyond the candidates'. Null without a primary, and
 * while a candidate ahead of any running one has not answered yet: the pages read nothing from an
 * environment that a later answer could displace.
 */
export function useFactoryEnvironmentId(): EnvironmentId | null {
  const primary = usePrimaryEnvironmentId();
  const connected = useConnectedEnvironmentIds();
  const candidates =
    primary === null ? connected : [primary, ...connected.filter((id) => id !== primary)];
  const state = useSyncExternalStore(
    (listener: () => void) => {
      const unsubscribes = candidates.map((id) => subscribe(id, "status", listener));
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
    () =>
      pickFactoryEnvironment(
        candidates,
        primary,
        (id) => snapshot(keyOf(id, "status")) as Loaded<FactoryStatus>,
      ),
  );
  const tickAll = () => candidates.forEach((id) => tick(keyOf(id, "status")));
  useLiveRefresh(tickAll, {
    key: "factory:environment",
    intervalMs: POLL_MS,
    enabled: candidates.length > 0,
  });
  return state;
}

/**
 * False once the factory environment's status answered 404: this server has no factory (an
 * upstream build), so the sidebar hides the item instead of leading to a page that cannot load.
 * True before any answer.
 */
export function useFactorySupported(): boolean {
  const { error } = useFactoryStatus(useFactoryEnvironmentId());
  return !(error instanceof FactoryApiError && error.status === 404);
}

/** The open attention items, for the sidebar badge: the last count known, 0 before any answer. */
export function useFactoryAttentionCount(): number {
  const { data } = useFactoryStatus(useFactoryEnvironmentId());
  return data?.attention.length ?? 0;
}

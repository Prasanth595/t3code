import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { environmentSession } from "~/state/session";
import { textField } from "./format";
import {
  DEFAULT_TIMEOUT_MS,
  FactoryHttpError,
  factoryRequest,
  failureMessage,
  parseJson,
  timeoutMessage,
} from "./http";

/** The factory's HTTP API as the server serves it (`apps/server/src/factory/t3/http.ts`). */

export interface FactoryAttentionItem {
  readonly id: string;
  readonly kind: string;
  readonly repo: string | null;
  readonly issue: number | null;
  readonly run: string | null;
  readonly message: string;
  /** ISO time the item was first raised. */
  readonly first_seen: string;
}

export interface FactoryStatus {
  readonly state: "running" | "idle";
  readonly reason: string | null;
  readonly paused_by_hand: { readonly since: string; readonly for_ms: number } | null;
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly state: string | null;
    readonly user: string | null;
    readonly for_ms: number | null;
    readonly pr_url: string | null;
    readonly thread_id: string | null;
    readonly unreadable: boolean;
  }>;
  readonly attention: ReadonlyArray<FactoryAttentionItem>;
  readonly slots: { readonly used: number; readonly max: number | null };
  readonly passes: unknown;
  readonly problems: ReadonlyArray<unknown>;
}

export interface FactoryRunRow {
  readonly id: string;
  readonly started_ts: string | null;
  readonly state: string | null;
  readonly last_event: string | null;
  readonly step: string | null;
  readonly status: string;
  readonly pr_url: string | null;
  readonly finished: boolean;
  readonly total_ms: number | null;
  readonly unreadable: boolean;
}

export interface FactoryEntry {
  readonly ts: string;
  readonly ms: number;
  readonly event: string;
  readonly data: unknown;
  readonly cause: unknown;
}

export interface FactoryRunDetail {
  readonly id: string;
  readonly entries: ReadonlyArray<FactoryEntry>;
  readonly truncated: boolean;
  readonly skipped: number;
}

export interface FactoryStopResult {
  readonly stopped: string;
  readonly already: boolean;
  readonly message: string;
}

export interface FactoryPauseResult {
  readonly paused: true;
  readonly already: boolean;
  readonly since: string;
  readonly message: string;
}

export interface FactoryResumeResult {
  readonly paused: false;
  readonly already: boolean;
  readonly message: string;
}

/** A non-2xx answer, or a request that never got one (`status` 0). */
export class FactoryApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "FactoryApiError";
    this.status = status;
    this.code = code;
  }
}

export interface FactoryApi {
  readonly status: () => Promise<FactoryStatus>;
  /** The recent window the server lists by default (`RECENT_FINISHED_MS`), or every run with `all`. */
  readonly runs: (options: {
    readonly all: boolean;
  }) => Promise<{ readonly runs: ReadonlyArray<FactoryRunRow> }>;
  readonly run: (id: string) => Promise<FactoryRunDetail>;
  readonly stopRun: (id: string) => Promise<FactoryStopResult>;
  readonly pauseClaims: () => Promise<FactoryPauseResult>;
  readonly resumeClaims: () => Promise<FactoryResumeResult>;
}

/**
 * How long one call may wait for its answer, the wait for a connection included. A server that
 * hangs then fails the call (status 0, code `timeout`) instead of pinning a page on loading and its
 * poll on a request that never ends.
 */
let timeoutMs = DEFAULT_TIMEOUT_MS;

/** For tests: how long a call waits; no argument restores the default. */
export const __setFactoryTimeoutForTests = (ms?: number): void => {
  timeoutMs = ms ?? DEFAULT_TIMEOUT_MS;
};

const connectionOverrideAtom = Atom.make<PreparedConnection | null | undefined>(undefined).pipe(
  Atom.keepAlive,
  Atom.withLabel("factory-connection-override"),
);

/** For tests: the connection every call uses (null: none yet); no argument restores the real one. */
export const __setFactoryConnectionForTests = (prepared?: PreparedConnection | null): void => {
  appAtomRegistry.set(connectionOverrideAtom, prepared);
};

/** The primary environment's prepared connection: the server this page was opened from or paired to. */
const primaryConnectionAtom = Atom.make((get): PreparedConnection | null => {
  const override = get(connectionOverrideAtom);
  if (override !== undefined) return override;
  const environmentId = get(primaryEnvironmentIdAtom);
  return environmentId === null
    ? null
    : Option.getOrNull(get(environmentSession.preparedConnectionValueAtom(environmentId)));
}).pipe(Atom.withLabel("factory-primary-connection"));

/** The connection now, or the first one that appears within `ms` (a call can precede startup). */
const connectionWithin = (ms: number): Promise<PreparedConnection> => {
  const current = appAtomRegistry.get(primaryConnectionAtom);
  if (current !== null) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new FactoryApiError(0, "no_connection", "The factory has no server connection yet."));
    }, ms);
    unsubscribe = appAtomRegistry.subscribe(primaryConnectionAtom, (prepared) => {
      if (prepared === null) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(prepared);
    });
  });
};

const call = async <T>(
  method: "GET" | "POST",
  path: string,
  searchParams?: Record<string, string>,
): Promise<T> => {
  // One deadline for the whole call: the request gets what the wait for a connection left.
  const deadline = Date.now() + timeoutMs;
  const timedOut = () => new FactoryApiError(0, "timeout", timeoutMessage(timeoutMs));
  let result;
  try {
    const prepared = await connectionWithin(timeoutMs);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timedOut();
    result = await factoryRequest(prepared, {
      method,
      path,
      searchParams,
      timeoutMs: remainingMs,
    });
  } catch (error) {
    if (error instanceof FactoryApiError) throw error;
    if (error instanceof FactoryHttpError && error.kind === "timeout") throw timedOut();
    throw new FactoryApiError(
      0,
      null,
      error instanceof Error && error.message ? error.message : "The request failed.",
    );
  }
  const body = parseJson(result.text);
  if (result.status < 200 || result.status >= 300) {
    throw new FactoryApiError(
      result.status,
      textField(body, "code"),
      failureMessage(result.status, body),
    );
  }
  return body as T;
};

const post = <T>(path: string) => call<T>("POST", path);
const get = <T>(path: string, searchParams?: Record<string, string>) =>
  call<T>("GET", path, searchParams);

const runPath = (id: string) => `/api/factory/runs/${encodeURIComponent(id)}`;

const httpApi: FactoryApi = {
  status: () => get("/api/factory/status"),
  runs: ({ all }) => get("/api/factory/runs", all ? { all: "1" } : undefined),
  run: (id) => get(runPath(id)),
  stopRun: (id) => post(`${runPath(id)}/stop`),
  pauseClaims: () => post("/api/factory/claims/pause"),
  resumeClaims: () => post("/api/factory/claims/resume"),
};

let override: FactoryApi | undefined;

/** Swaps the API for a test; no argument restores the HTTP one. */
export const __setFactoryApiForTests = (api?: FactoryApi): void => {
  override = api;
};

/** Delegates on every call, so a swap takes effect for hooks that already hold the object. */
export const factoryApi: FactoryApi = {
  status: () => (override ?? httpApi).status(),
  runs: (options) => (override ?? httpApi).runs(options),
  run: (id) => (override ?? httpApi).run(id),
  stopRun: (id) => (override ?? httpApi).stopRun(id),
  pauseClaims: () => (override ?? httpApi).pauseClaims(),
  resumeClaims: () => (override ?? httpApi).resumeClaims(),
};

import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";

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
  readonly stopped: boolean;
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
  readonly runs: () => Promise<{ readonly runs: ReadonlyArray<FactoryRunRow> }>;
  readonly run: (id: string) => Promise<FactoryRunDetail>;
  readonly stopRun: (id: string) => Promise<FactoryStopResult>;
  readonly pauseClaims: () => Promise<FactoryPauseResult>;
  readonly resumeClaims: () => Promise<FactoryResumeResult>;
}

let runtime: ManagedRuntime.ManagedRuntime<HttpClient.HttpClient, never> | null = null;
const getRuntime = () => (runtime ??= ManagedRuntime.make(PrimaryEnvironmentHttpLayer.layer));

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const field = (body: unknown, key: string): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

const call = async <T>(method: "GET" | "POST", path: string): Promise<T> => {
  const program = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = resolvePrimaryEnvironmentHttpUrl(path);
    const response = yield* client.execute(
      method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url),
    );
    const text = yield* response.text;
    return { status: response.status, text };
  });
  let result: { status: number; text: string };
  try {
    result = await getRuntime().runPromise(program);
  } catch (error) {
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
      field(body, "code"),
      field(body, "message") ?? `The factory answered ${result.status}.`,
    );
  }
  return body as T;
};

const post = <T>(path: string) => call<T>("POST", path);
const get = <T>(path: string) => call<T>("GET", path);

const runPath = (id: string) => `/api/factory/runs/${encodeURIComponent(id)}`;

const httpApi: FactoryApi = {
  status: () => get("/api/factory/status"),
  runs: () => get("/api/factory/runs"),
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
  runs: () => (override ?? httpApi).runs(),
  run: (id) => (override ?? httpApi).run(id),
  stopRun: (id) => (override ?? httpApi).stopRun(id),
  pauseClaims: () => (override ?? httpApi).pauseClaims(),
  resumeClaims: () => (override ?? httpApi).resumeClaims(),
};

// StudioActivitySink.ts — HTTP sink for the studio activity publisher.
//
// POSTs the publisher envelope to `${baseUrl}/api/studio/producers` with
// `Authorization: Bearer <token>`. Configuration comes only from the
// environment (`NOFUN_STUDIO_BRIDGE_URL` / `NOFUN_STUDIO_BRIDGE_TOKEN`), read
// once at startup. When either is missing the sink is a no-op that never
// touches the network. Failures (network error, non-2xx, timeout) are
// swallowed: the runtime must never block or crash on bridge delivery, and
// there is no retry (the next publish supersedes with a fresh snapshot).
//
// Never reads keychain or files for credentials. Never logs the token.

import type { StudioActivitySink } from "./StudioActivityPublisher.ts";

export const STUDIO_ACTIVITY_BRIDGE_URL_ENV = "NOFUN_STUDIO_BRIDGE_URL" as const;
export const STUDIO_ACTIVITY_BRIDGE_TOKEN_ENV = "NOFUN_STUDIO_BRIDGE_TOKEN" as const;
export const STUDIO_ACTIVITY_PRODUCERS_PATH = "/api/studio/producers" as const;
export const STUDIO_ACTIVITY_SEND_TIMEOUT_MS = 5_000;

export interface StudioActivityBridgeConfig {
  readonly baseUrl: string;
  readonly token: string;
}

export type StudioActivityFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Both vars required; no default URL. Returns null when unconfigured. */
export function readStudioActivityBridgeConfig(
  env: Readonly<Record<string, string | undefined>>,
): StudioActivityBridgeConfig | null {
  const baseUrl = (env[STUDIO_ACTIVITY_BRIDGE_URL_ENV] ?? "").trim().replace(/\/+$/, "");
  const token = (env[STUDIO_ACTIVITY_BRIDGE_TOKEN_ENV] ?? "").trim();
  if (baseUrl.length === 0 || token.length === 0) return null;
  return { baseUrl, token };
}

export function studioActivityProducersUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${STUDIO_ACTIVITY_PRODUCERS_PATH}`;
}

/**
 * POST the envelope once per send. Never rejects: network errors, non-2xx
 * responses and timeouts resolve silently. The envelope carries shell fields
 * only (the publisher guarantees that); the token travels solely in the
 * Authorization header, never in the body.
 */
export function makeStudioActivityHttpSink(options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchFn?: StudioActivityFetch | undefined;
  readonly timeoutMs?: number | undefined;
}): StudioActivitySink {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? STUDIO_ACTIVITY_SEND_TIMEOUT_MS;
  const url = studioActivityProducersUrl(options.baseUrl);
  const authorization = `Bearer ${options.token}`;
  return {
    send: async (input) => {
      try {
        const response = await fetchFn(url, {
          method: "POST",
          headers: { Authorization: authorization, "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // No response payload is needed, including for non-2xx. Release the
        // body so a stream of header-only responses cannot retain connections.
        await response.body?.cancel();
      } catch {
        // Network error, abort/timeout, or a throwing fetch: swallowed.
      }
    },
  };
}

/** No-op sink for the unconfigured bridge: zero network calls. */
export const STUDIO_ACTIVITY_NOOP_SINK: StudioActivitySink = {
  send: () => {},
};

/** Configured HTTP sink, or the no-op sink when either env var is missing. */
export function makeStudioActivitySink(options: {
  readonly config: StudioActivityBridgeConfig | null;
  readonly fetchFn?: StudioActivityFetch | undefined;
  readonly timeoutMs?: number | undefined;
}): StudioActivitySink {
  if (!options.config) return STUDIO_ACTIVITY_NOOP_SINK;
  return makeStudioActivityHttpSink({
    baseUrl: options.config.baseUrl,
    token: options.config.token,
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
  });
}

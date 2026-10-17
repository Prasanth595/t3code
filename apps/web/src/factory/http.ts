/**
 * The one way the factory pages reach the server: a plain `fetch` on a connection's HTTP base that
 * carries the connection's credential itself. The factory API is not part of the typed environment
 * HTTP API (that is the point of the seam, see factory/docs/design.md), so T3's shared HTTP client
 * does not cover it. Going through the connection, not the page's own origin, is what lets the
 * pages work from a phone paired to a remote server: the session cookie when there is no bearer
 * token, `Authorization: Bearer` when there is. A relay (DPoP) connection needs a signed proof per
 * request, which the shared helper only issues for the typed API groups, so it is reported as
 * unsupported rather than sent unauthenticated.
 */
import type { PreparedConnection } from "@t3tools/client-runtime/connection";

import { textField } from "./format";

/** How long one call may wait for its answer. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** A call that was not sent (`relay`) or got no answer in time (`timeout`). */
export class FactoryHttpError extends Error {
  readonly kind: "relay" | "timeout";
  constructor(kind: "relay" | "timeout", message: string) {
    super(message);
    this.name = "FactoryHttpError";
    this.kind = kind;
  }
}

export interface FactoryHttpRequest {
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly searchParams?: Record<string, string> | undefined;
  /** Sent as JSON. */
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export interface FactoryHttpResponse {
  readonly status: number;
  readonly text: string;
}

/**
 * Sends one request on `prepared` and reads the whole answer within the timeout. Any status comes
 * back as a response for the caller to map; a request that never gets one rejects.
 */
export const factoryRequest = async (
  prepared: PreparedConnection,
  request: FactoryHttpRequest,
): Promise<FactoryHttpResponse> => {
  const authorization = prepared.httpAuthorization;
  if (authorization?._tag === "Dpop") {
    throw new FactoryHttpError(
      "relay",
      "The factory is not available over a relay connection yet.",
    );
  }
  const url = new URL(`${prepared.httpBaseUrl.replace(/\/+$/, "")}${request.path}`);
  for (const [key, value] of Object.entries(request.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new FactoryHttpError(
          "timeout",
          `The factory did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
        ),
      );
    }, timeoutMs);
  });
  const send = async (): Promise<FactoryHttpResponse> => {
    const response = await fetch(url, {
      method: request.method,
      signal: controller.signal,
      // A cookie session sends no header; a bearer token must not also send cookies.
      credentials: authorization === null ? "include" : "omit",
      headers: {
        accept: "application/json",
        ...(authorization === null ? {} : { authorization: `Bearer ${authorization.token}` }),
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    return { status: response.status, text: await response.text() };
  };
  try {
    return await Promise.race([send(), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The server's own `message` for a non-2xx answer, else the status. */
export const failureMessage = (status: number, body: unknown): string =>
  textField(body, "message") ?? `The factory answered ${status}.`;

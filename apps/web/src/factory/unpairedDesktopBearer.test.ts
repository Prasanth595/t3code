// The packaged desktop hands the web UI the factory server as its primary environment and a
// bearer that is "" before pairing, or a stale one after the server forgets it. Both must end on
// the pairing page, never in a retry loop or a generic error.
//
// A fake factory server answers over fetch, the way the real one does: `/api/auth/session`
// says 200 `{ authenticated: false }` for a missing or unknown bearer, and the websocket-ticket
// endpoint says 401 `EnvironmentAuthInvalidError`.
import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/client-runtime/authorization";
import {
  ConnectionBlockedError,
  mapRemoteEnvironmentError,
} from "@t3tools/client-runtime/connection";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { PRIMARY_LOCAL_ENVIRONMENT_ID, type DesktopBridge } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { __resetDesktopPrimaryAuthForTests } from "../environments/primary/desktopAuth";

const FACTORY_HTTP = "http://127.0.0.1:3876/";
const FACTORY_WS = "ws://127.0.0.1:3876/";
const PAIRED_BEARER = "paired-bearer";

const AUTH_DESCRIPTOR = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
} as const;

/** Answers like the real server: only the paired bearer is known. */
const fakeFactoryServer = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  const authorization = request.headers.get("authorization");
  if (pathname === "/api/auth/session") {
    return Promise.resolve(Response.json({ authenticated: false, auth: AUTH_DESCRIPTOR }));
  }
  if (pathname === "/api/auth/websocket-ticket") {
    return Promise.resolve(
      authorization === `Bearer ${PAIRED_BEARER}`
        ? Response.json({ ticket: "ticket-1", expiresAt: "2026-06-06T01:00:00.000Z" })
        : Response.json(
            {
              _tag: "EnvironmentAuthInvalidError",
              code: "auth_invalid",
              reason: authorization === null ? "missing_credential" : "invalid_credential",
              traceId: "trace-auth-invalid",
            },
            { status: 401 },
          ),
    );
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
};

/** authorizeBearer's ticket request, over the fake server. */
const requestConnectionUrl = (bearerToken: string) =>
  resolveRemoteWebSocketConnectionUrl({
    wsBaseUrl: FACTORY_WS,
    httpBaseUrl: FACTORY_HTTP,
    bearerToken,
  }).pipe(Effect.provide(layerRemoteHttpClient(fakeFactoryServer)));

function installDesktop(bearer: string) {
  vi.stubGlobal("fetch", fakeFactoryServer);
  vi.stubGlobal("window", {
    location: new URL("http://localhost/"),
    history: { state: null, replaceState: vi.fn() },
    desktopBridge: {
      getLocalEnvironmentBootstraps: () => [
        {
          id: PRIMARY_LOCAL_ENVIRONMENT_ID,
          label: "Factory server",
          runningDistro: null,
          httpBaseUrl: FACTORY_HTTP,
          wsBaseUrl: FACTORY_WS,
        },
      ],
      getLocalEnvironmentBearerToken: () => Promise.resolve(bearer),
    } as unknown as DesktopBridge,
  });
  vi.stubGlobal("document", { title: "T3 Code" });
}

describe.each([
  ["an unpaired desktop (empty bearer)", ""],
  ["a bearer the server no longer knows", "stale-bearer"],
])("%s", (_name, bearer) => {
  beforeEach(() => {
    __resetDesktopPrimaryAuthForTests();
    installDesktop(bearer);
  });

  afterEach(async () => {
    const { __resetServerAuthBootstrapForTests } = await import("../environments/primary");
    __resetServerAuthBootstrapForTests();
    vi.unstubAllGlobals();
  });

  it("shows the pairing page", async () => {
    const { resolveInitialServerAuthGateState } = await import("../environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: AUTH_DESCRIPTOR,
    });
  });

  it("blocks the connection on authentication instead of retrying", async () => {
    const { readDesktopPrimaryBearerToken } = await import("../environments/primary/desktopAuth");
    // The web connection platform's PrimaryEnvironmentAuth.bearerToken, in full:
    // readDesktopPrimaryBearerToken mapped through Option.fromNullishOr.
    const primaryBearer = Option.fromNullishOr(await readDesktopPrimaryBearerToken());
    expect(Option.isSome(primaryBearer)).toBe(true);

    // authorizeBearer's ticket request and error mapping. A ConnectionBlockedError parks the
    // supervisor in phase "blocked" with retryAt null (supervisor.ts); only a
    // ConnectionTransientError schedules a retry.
    const error = await Effect.runPromise(
      requestConnectionUrl(Option.getOrThrow(primaryBearer)).pipe(
        Effect.mapError((cause) => mapRemoteEnvironmentError(cause)),
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(ConnectionBlockedError);
    expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "authentication" });
  });
});

describe("a paired desktop", () => {
  beforeEach(() => {
    __resetDesktopPrimaryAuthForTests();
    installDesktop(PAIRED_BEARER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gets a websocket ticket, so the blocked cases above come from the bearer alone", async () => {
    const url = await Effect.runPromise(requestConnectionUrl(PAIRED_BEARER));

    expect(url).toContain("wsTicket=ticket-1");
  });
});

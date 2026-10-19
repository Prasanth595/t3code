import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";

import { __resetDesktopPrimaryAuthForTests } from "./desktopAuth";
import * as PrimaryEnvironmentHttpLayer from "./httpLayer";

describe("primary environment HTTP layer", { concurrent: false }, () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
  });

  it.effect("uses cookie credentials for browser primary environments", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "http://127.0.0.1:3773/settings",
          origin: "http://127.0.0.1:3773",
        },
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://127.0.0.1:3773/api/auth/session");

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).toBe("include");
      expect(request.headers.get("authorization")).toBeNull();
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });

  it.effect("uses bearer auth without cookies for desktop-managed primaries", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "t3code://app" },
        desktopBridge: {
          getLocalEnvironmentBootstrap: () => ({
            label: "Local environment",
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
            bootstrapToken: "desktop-bootstrap-token",
          }),
          getLocalEnvironmentBearerToken: vi.fn().mockResolvedValue("desktop-bearer-token"),
        } as unknown as DesktopBridge,
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://127.0.0.1:3773/api/connect/link-state");

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });

  it.effect("refreshes after a 401 and retries the request once", () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const getToken = vi.fn().mockResolvedValueOnce("revoked").mockResolvedValue("fresh");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "t3code://app" },
        desktopBridge: {
          getLocalEnvironmentBootstrap: () => ({
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
          }),
          getLocalEnvironmentBearerToken: getToken,
        },
      },
    });
    return Effect.gen(function* () {
      const response = yield* HttpClient.get("http://127.0.0.1:3773/api/connect/link-state");
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(getToken).toHaveBeenLastCalledWith("revoked");
      const request = new Request(fetchMock.mock.calls[1]?.[0], fetchMock.mock.calls[1]?.[1]);
      expect(request.headers.get("authorization")).toBe("Bearer fresh");
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });

  it.effect("recovers an anonymous session probe without consuming the response body", () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ authenticated: false }))
      .mockResolvedValue(Response.json({ authenticated: true }));
    vi.stubGlobal("fetch", fetchMock);
    const getToken = vi.fn().mockResolvedValueOnce("revoked").mockResolvedValue("fresh");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "t3code://app" },
        desktopBridge: {
          getLocalEnvironmentBootstrap: () => ({
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
          }),
          getLocalEnvironmentBearerToken: getToken,
        },
      },
    });
    return Effect.gen(function* () {
      const response = yield* HttpClient.get("http://127.0.0.1:3773/api/auth/session");
      expect(yield* response.json).toEqual({ authenticated: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(getToken).toHaveBeenLastCalledWith("revoked");
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });
});

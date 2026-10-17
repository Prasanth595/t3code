import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { PreparedConnection } from "@t3tools/client-runtime/connection";

import { fetchFactoryConfig, saveFactoryConfig, type MachineConfigValues } from "./api";

// Only the wire is stubbed: the real settings API runs against a fetch stand-in, on a connection
// whose HTTP base is not the window's own origin.
const WINDOW_ORIGIN = "http://127.0.0.1:3773";
const REMOTE_BASE = "https://personal-mac.tail1234.ts.net:3876";
const cookieConnection = {
  httpBaseUrl: REMOTE_BASE,
  httpAuthorization: null,
} as unknown as PreparedConnection;
const bearerConnection = {
  httpBaseUrl: `${REMOTE_BASE}/`,
  httpAuthorization: { _tag: "Bearer", token: "tok-1" },
} as unknown as PreparedConnection;
const dpopConnection = {
  httpBaseUrl: REMOTE_BASE,
  httpAuthorization: { _tag: "Dpop" },
} as unknown as PreparedConnection;

const fetchMock = vi.fn<typeof fetch>();

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: `${WINDOW_ORIGIN}/settings`, origin: WINDOW_ORIGIN } },
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "window");
  vi.unstubAllGlobals();
});

afterEach(() => {
  fetchMock.mockReset();
});

const answer = (status: number, body: string) =>
  fetchMock.mockResolvedValueOnce(new Response(body, { status }));

const sent = () => {
  const call = fetchMock.mock.calls.at(-1)!;
  return new Request(call[0], call[1]);
};

const report = { file: "/tmp/factory.yml", exists: true, config: null, errors: [], repos: [] };
const values: MachineConfigValues = {
  gh_config_dir: "",
  poll_seconds: 45,
  max_concurrent_runs: 2,
  max_concurrent_gates: 1,
};

describe("fetchFactoryConfig", () => {
  it("returns the report of a 200", async () => {
    answer(200, JSON.stringify(report));
    expect(await fetchFactoryConfig(cookieConnection)).toEqual({ kind: "ok", report });
  });

  it("calls the connection's /api/factory/config, not the window's origin", async () => {
    answer(200, JSON.stringify(report));
    await fetchFactoryConfig(bearerConnection);
    expect(sent().url).toBe(`${REMOTE_BASE}/api/factory/config`);
    expect(sent().method).toBe("GET");
  });

  it("maps a 403 to forbidden", async () => {
    answer(403, JSON.stringify({ message: "no" }));
    expect(await fetchFactoryConfig(cookieConnection)).toEqual({ kind: "forbidden" });
  });

  it("maps a 422 to invalid with the server's errors", async () => {
    const errors = [{ file: "factory.yml", field: "poll_seconds", message: "must be positive" }];
    answer(422, JSON.stringify({ errors }));
    expect(await fetchFactoryConfig(cookieConnection)).toEqual({ kind: "invalid", errors });
  });

  it("maps a 500 with a JSON message to an error carrying that message", async () => {
    answer(500, JSON.stringify({ message: "disk on fire" }));
    expect(await fetchFactoryConfig(cookieConnection)).toEqual({
      kind: "error",
      message: "disk on fire",
    });
  });

  it("maps a 500 that is not JSON to an error naming the status", async () => {
    answer(500, "<html>oops</html>");
    expect(await fetchFactoryConfig(cookieConnection)).toEqual({
      kind: "error",
      message: "The factory answered 500.",
    });
  });

  it("maps a 200 that is not JSON to an error, not an ok with no report", async () => {
    answer(200, "<html>app shell</html>");
    const result = await fetchFactoryConfig(cookieConnection);
    expect(result.kind).toBe("error");
  });

  it("maps a 422 that is not JSON to an error", async () => {
    answer(422, "<html>proxy</html>");
    const result = await fetchFactoryConfig(cookieConnection);
    expect(result.kind).toBe("error");
  });

  it("maps a network failure to an error with its message", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await fetchFactoryConfig(cookieConnection)).toEqual({
      kind: "error",
      message: "Failed to fetch",
    });
  });

  it("reports a relay connection without sending anything", async () => {
    const result = await fetchFactoryConfig(dpopConnection);
    expect(result).toEqual({
      kind: "error",
      message: "The factory is not available over a relay connection yet.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("saveFactoryConfig", () => {
  it("PUTs the values as JSON with a bearer token and no cookies", async () => {
    answer(200, JSON.stringify(report));
    const result = await saveFactoryConfig(bearerConnection, values);
    expect(result.kind).toBe("ok");
    const request = sent();
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(`${REMOTE_BASE}/api/factory/config`);
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("authorization")).toBe("Bearer tok-1");
    expect(request.credentials).toBe("omit");
    expect(await request.json()).toEqual(values);
  });

  it("sends the session cookie and no authorization header on a cookie connection", async () => {
    answer(200, JSON.stringify(report));
    await saveFactoryConfig(cookieConnection, values);
    const request = sent();
    expect(request.credentials).toBe("include");
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("content-type")).toBe("application/json");
  });
});

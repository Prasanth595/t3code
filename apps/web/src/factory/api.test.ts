import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { PreparedConnection } from "@t3tools/client-runtime/connection";

import {
  __setFactoryConnectionForTests,
  __setFactoryTimeoutForTests,
  FactoryApiError,
  factoryApi,
} from "./api";

// Only the wire is stubbed: the calls go through `fetch` against the connected environment's HTTP
// base, never the window's own origin (kept at 127.0.0.1:3773 here to prove it).
const WINDOW_ORIGIN = "http://127.0.0.1:3773";
const cookieConnection = (httpBaseUrl = WINDOW_ORIGIN) =>
  ({ httpBaseUrl, httpAuthorization: null }) as unknown as PreparedConnection;
const REMOTE_BASE = "https://personal-mac.tail1234.ts.net:3876";
const bearerConnection = {
  httpBaseUrl: `${REMOTE_BASE}/`,
  httpAuthorization: { _tag: "Bearer", token: "tok-1" },
} as unknown as PreparedConnection;

const fetchMock = vi.fn<typeof fetch>();

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: `${WINDOW_ORIGIN}/factory`, origin: WINDOW_ORIGIN },
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "window");
  vi.unstubAllGlobals();
});

beforeEach(() => {
  __setFactoryConnectionForTests(cookieConnection());
});

afterEach(() => {
  fetchMock.mockReset();
  __setFactoryTimeoutForTests();
  __setFactoryConnectionForTests();
});

const answer = (status: number, body: string, contentType = "application/json") =>
  fetchMock.mockResolvedValueOnce(
    new Response(body, { status, headers: { "content-type": contentType } }),
  );

/** The request the last call sent. */
const sent = () => {
  const call = fetchMock.mock.calls.at(-1)!;
  return new Request(call[0], call[1]);
};

const failure = async (call: Promise<unknown>): Promise<FactoryApiError> => {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(FactoryApiError);
    return error as FactoryApiError;
  }
  throw new Error("the call did not fail");
};

describe("factoryApi over HTTP", () => {
  it("reads with GET and returns the body as JSON", async () => {
    answer(200, '{"runs":[{"id":"o__r__1__1"}]}');
    expect(await factoryApi.runs({ all: false })).toEqual({ runs: [{ id: "o__r__1__1" }] });
    expect(sent().method).toBe("GET");
    const url = new URL(sent().url);
    expect([url.pathname, url.search]).toEqual(["/api/factory/runs", ""]);
  });

  it("asks for every run with ?all=1", async () => {
    answer(200, '{"runs":[]}');
    await factoryApi.runs({ all: true });
    const url = new URL(sent().url);
    expect([url.pathname, url.search]).toEqual(["/api/factory/runs", "?all=1"]);
  });

  it("stops a run with a POST to its encoded path", async () => {
    answer(200, '{"stopped":"a/b","already":false,"message":"stop requested"}');
    const result = await factoryApi.stopRun("a/b");
    expect(result.message).toBe("stop requested");
    expect(sent().method).toBe("POST");
    expect(new URL(sent().url).pathname).toBe("/api/factory/runs/a%2Fb/stop");
  });

  it("maps an error body to the status, code and message", async () => {
    answer(404, '{"code":"run_not_found","message":"no such run"}');
    const error = await failure(factoryApi.run("x"));
    expect([error.status, error.code, error.message]).toEqual([
      404,
      "run_not_found",
      "no such run",
    ]);
  });

  it("names the status when the error body is not JSON", async () => {
    answer(500, "boom", "text/plain");
    const error = await failure(factoryApi.status());
    expect([error.status, error.code, error.message]).toEqual([
      500,
      null,
      "The factory answered 500.",
    ]);
  });

  it("is status 0 when the request never got an answer", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const error = await failure(factoryApi.status());
    expect(error.status).toBe(0);
    expect(error.code).toBeNull();
    expect(error.message).not.toBe("");
  });

  it("gives up on an answer that does not come in time", async () => {
    __setFactoryTimeoutForTests(20);
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const error = await failure(factoryApi.status());
    expect([error.status, error.code]).toEqual([0, "timeout"]);
    expect(error.message).toContain("did not answer");
  });

  it("keeps an answer that comes before the time is up", async () => {
    __setFactoryTimeoutForTests(1000);
    answer(200, '{"state":"idle"}');
    expect(await factoryApi.status()).toEqual({ state: "idle" });
  });
});

describe("factoryApi on the connected environment", () => {
  it("sends to a remote environment's base with its bearer token and no cookies", async () => {
    __setFactoryConnectionForTests(bearerConnection);
    answer(200, '{"state":"idle"}');
    await factoryApi.status();
    const [target, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(target)).toBe(`${REMOTE_BASE}/api/factory/status`);
    expect(new URL(String(target)).origin).not.toBe(WINDOW_ORIGIN);
    expect(sent().headers.get("authorization")).toBe("Bearer tok-1");
    expect(init?.credentials).toBe("omit");
  });

  it("sends a cookie session's request with credentials and no authorization header", async () => {
    __setFactoryConnectionForTests(cookieConnection("https://other-host.test:4000"));
    answer(200, '{"state":"idle"}');
    await factoryApi.status();
    const [target, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(target)).toBe("https://other-host.test:4000/api/factory/status");
    expect(init?.credentials).toBe("include");
    expect(sent().headers.get("authorization")).toBeNull();
  });

  it("fails without sending over a relay (DPoP) connection", async () => {
    __setFactoryConnectionForTests({
      httpBaseUrl: REMOTE_BASE,
      httpAuthorization: { _tag: "Dpop" },
    } as unknown as PreparedConnection);
    const error = await failure(factoryApi.status());
    expect(error.status).toBe(0);
    expect(error.message).toBe("The factory is not available over a relay connection yet.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for a connection that appears after the call started", async () => {
    __setFactoryConnectionForTests(null);
    answer(200, '{"state":"idle"}');
    const pending = factoryApi.status();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    __setFactoryConnectionForTests(bearerConnection);
    expect(await pending).toEqual({ state: "idle" });
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(`${REMOTE_BASE}/api/factory/status`);
  });

  it("fails with no_connection when none appears within the time", async () => {
    __setFactoryTimeoutForTests(20);
    __setFactoryConnectionForTests(null);
    const error = await failure(factoryApi.status());
    expect([error.status, error.code]).toEqual([0, "no_connection"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

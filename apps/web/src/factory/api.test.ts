import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { __setFactoryTimeoutForTests, FactoryApiError, factoryApi } from "./api";

// The real HTTP layer with only the wire stubbed: the page's calls go through `fetch` as the
// browser's would, against the window's own origin.
const fetchMock = vi.fn<typeof fetch>();

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: "http://127.0.0.1:3773/factory", origin: "http://127.0.0.1:3773" },
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "window");
  vi.unstubAllGlobals();
});

afterEach(() => {
  fetchMock.mockReset();
  __setFactoryTimeoutForTests();
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
    expect(await factoryApi.runs()).toEqual({ runs: [{ id: "o__r__1__1" }] });
    expect(sent().method).toBe("GET");
    expect(new URL(sent().url).pathname).toBe("/api/factory/runs");
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

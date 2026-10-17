import { createElement, act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { __setFactoryApiForTests, FactoryApiError, type FactoryApi } from "./api";
import {
  __resetFactoryStoresForTests,
  useFactoryAttentionCount,
  useFactoryRun,
  useFactoryRuns,
  useFactoryStatus,
  useFactorySupported,
  type FactoryResource,
} from "./useFactoryData";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status = (attention: number) => ({
  state: "running" as const,
  reason: null,
  paused_by_hand: null,
  runs: [],
  attention: Array.from({ length: attention }, (_, i) => ({
    id: `a${i}`,
    kind: "stuck",
    repo: "o/r",
    issue: i,
    run: null,
    message: "m",
    first_seen: "2026-10-04T10:00:00.000Z",
  })),
  slots: { used: 0, max: 1 },
  passes: {},
  problems: [],
});

const api = (overrides: Partial<FactoryApi>): FactoryApi => ({
  status: vi.fn(async () => status(0)),
  runs: vi.fn(async () => ({ runs: [] })),
  run: vi.fn(async (id: string) => ({ id, entries: [], truncated: false, skipped: 0 })),
  stopRun: vi.fn(),
  pauseClaims: vi.fn(),
  resumeClaims: vi.fn(),
  ...overrides,
});

const notFound = async () => {
  throw new FactoryApiError(404, null, "Not found");
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

let renderers: Array<ReactTestRenderer> = [];
const unmountAll = () => {
  act(() => renderers.forEach((r) => r.unmount()));
  renderers = [];
};

/** Renders a component that reads `useHook` and keeps what it returned last. */
const mount = async <T>(useHook: () => T) => {
  const latest = { current: undefined as T };
  const Probe = () => {
    latest.current = useHook();
    return null;
  };
  await act(async () => {
    renderers.push(create(createElement(Probe)));
  });
  return latest;
};

const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

// The live-refresh policy reads the window the hooks poll through.
const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
const window = new EventTarget();
const show = (visible: boolean) =>
  act(async () => {
    document.visibilityState = visible ? "visible" : "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });

// The policy remembers when each key was last read, across tests, so every test starts a day
// after the one before it: a stale stamp would otherwise swallow the first tick.
let day = Date.parse("2026-10-17T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  day += 86_400_000;
  vi.setSystemTime(day);
  document.visibilityState = "visible";
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
});

afterEach(() => {
  unmountAll();
  __setFactoryApiForTests();
  __resetFactoryStoresForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useFactoryStatus", () => {
  it("is loading, then ready with the fetched status", async () => {
    const pending = deferred<ReturnType<typeof status>>();
    __setFactoryApiForTests(api({ status: () => pending.promise }));
    const result = await mount(useFactoryStatus);
    expect(result.current.status).toBe("loading");
    expect(result.current.data).toBeNull();
    await act(async () => pending.resolve(status(2)));
    expect(result.current.status).toBe("ready");
    expect(result.current.data?.attention).toHaveLength(2);
  });

  it("is an error with the thrown error when the fetch fails", async () => {
    __setFactoryApiForTests(
      api({
        status: async () => {
          throw new FactoryApiError(403, null, "forbidden");
        },
      }),
    );
    const result = await mount(useFactoryStatus);
    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toBe("forbidden");
  });

  it("keeps the last data when a later fetch fails", async () => {
    let fail = false;
    __setFactoryApiForTests(
      api({
        status: async () => {
          if (fail) throw new Error("down");
          return status(2);
        },
      }),
    );
    const result = await mount(useFactoryStatus);
    fail = true;
    await settle(30_000);
    expect(result.current.status).toBe("error");
    expect(result.current.data?.attention).toHaveLength(2);
  });

  it("fetches again every 30 seconds and on refresh, and not in between", async () => {
    const fetchStatus = vi.fn(async () => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const result = await mount(useFactoryStatus);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await settle(29_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await settle(1_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await act(async () => result.current.refresh());
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("stops polling when unmounted, and ignores an answer that arrives after", async () => {
    const pending = deferred<ReturnType<typeof status>>();
    const fetchStatus = vi.fn(() => pending.promise);
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount(useFactoryStatus);
    unmountAll();
    await act(async () => pending.resolve(status(1)));
    await settle(120_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // react-test-renderer itself warns that it is deprecated; any other error is a real one.
    expect(
      errors.mock.calls.filter(([message]) => !String(message).includes("deprecated")),
    ).toEqual([]);
    errors.mockRestore();
  });
});

describe("the poll follows the window", () => {
  it("does not tick while the window is hidden, and reads on coming back to it", async () => {
    const fetchStatus = vi.fn(async () => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    await mount(useFactoryStatus);
    await show(false);
    await settle(90_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await show(true);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("a tick during a slow answer joins it instead of starting another read", async () => {
    const pending = deferred<ReturnType<typeof status>>();
    const fetchStatus = vi.fn(() => pending.promise);
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const result = await mount(useFactoryStatus);
    await settle(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(status(3)));
    expect(result.current.data?.attention).toHaveLength(3);
    await settle(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("a refresh during a slow answer reads again, and the answer in flight is dropped", async () => {
    const before = deferred<ReturnType<typeof status>>();
    const after = deferred<ReturnType<typeof status>>();
    const calls = [before, after];
    const fetchStatus = vi.fn(() => calls.shift()!.promise);
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const result = await mount(useFactoryStatus);
    await act(async () => result.current.refresh());
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await act(async () => before.resolve(status(1)));
    expect(result.current.status).toBe("loading");
    await act(async () => after.resolve(status(5)));
    expect(result.current.data?.attention).toHaveLength(5);
  });

  it("reads no more after a 404, which says the server has no factory", async () => {
    const fetchStatus = vi.fn(notFound);
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const result = await mount(useFactoryStatus);
    expect(result.current.status).toBe("error");
    await settle(90_000);
    await show(false);
    await show(true);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });
});

describe("useFactoryStatus shared by several readers", () => {
  it("polls once for two readers, on mount and on every tick", async () => {
    const fetchStatus = vi.fn(async () => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    await mount(useFactoryStatus);
    await mount(useFactoryStatus);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await settle(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("still reads when the timer fires a few milliseconds before 30 seconds have passed", async () => {
    const fetchStatus = vi.fn(async () => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const result = await mount(useFactoryStatus);
    await settle(10);
    // The wall clock falls 5 ms behind the timer, so the tick sees 29 995 ms since the last start.
    vi.setSystemTime(day + 5);
    await act(async () => result.current.refresh());
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle(29_990);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("reads once per 30 seconds for two readers whose timers are out of step", async () => {
    const fetchStatus = vi.fn(async () => status(0));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    await mount(useFactoryStatus);
    await settle(15_000);
    await mount(useFactoryAttentionCount);
    await settle(15_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle(15_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await settle(15_000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    await settle(15_000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("shows a refresh from one reader to the other", async () => {
    let attention = 0;
    __setFactoryApiForTests(api({ status: async () => status(attention) }));
    const page = await mount(useFactoryStatus);
    const badge = await mount(useFactoryAttentionCount);
    expect(badge.current).toBe(0);
    attention = 2;
    await act(async () => page.current.refresh());
    expect(badge.current).toBe(2);
  });

  it("stops every timer once both readers are gone", async () => {
    __setFactoryApiForTests(api({}));
    await mount(useFactoryStatus);
    await mount(useFactoryStatus);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmountAll();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useFactoryRuns and useFactoryRun", () => {
  it("fetch the run list and one run's ledger", async () => {
    const run = vi.fn(async (id: string) => ({ id, entries: [], truncated: true, skipped: 3 }));
    __setFactoryApiForTests(
      api({
        runs: async () => ({
          runs: [
            {
              id: "o__r__1__1",
              started_ts: null,
              state: "building",
              last_event: "claimed",
              step: null,
              status: "running",
              pr_url: null,
              finished: false,
              total_ms: null,
              unreadable: false,
            },
          ],
        }),
        run,
      }),
    );
    const runs = await mount(useFactoryRuns);
    expect(runs.current.data?.runs.map((r) => r.id)).toEqual(["o__r__1__1"]);
    const one = await mount(() => useFactoryRun("o__r__1__1"));
    expect(run).toHaveBeenCalledWith("o__r__1__1");
    expect((one.current as FactoryResource<{ skipped: number }>).data?.skipped).toBe(3);
  });

  it("asks the server for every run only with all, and reads that list once, not on the poll", async () => {
    const fetchRuns = vi.fn<FactoryApi["runs"]>(async () => ({ runs: [] }));
    __setFactoryApiForTests(api({ runs: fetchRuns }));
    await mount(() => useFactoryRuns());
    expect(fetchRuns).toHaveBeenLastCalledWith({ all: false });
    await mount(() => useFactoryRuns(true));
    expect(fetchRuns).toHaveBeenLastCalledWith({ all: true });
    expect(fetchRuns).toHaveBeenCalledTimes(2);
    await settle(90_000);
    expect(fetchRuns).toHaveBeenCalledTimes(5);
    expect(fetchRuns.mock.calls.slice(2).every(([options]) => options.all === false)).toBe(true);
  });

  it("reads a run no more after a 404", async () => {
    const run = vi.fn(notFound);
    __setFactoryApiForTests(api({ run }));
    const one = await mount(() => useFactoryRun("o__r__9__1"));
    expect((one.current.error as FactoryApiError).status).toBe(404);
    await settle(90_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("useFactoryAttentionCount", () => {
  it("is 0 while loading", async () => {
    __setFactoryApiForTests(api({ status: () => new Promise(() => {}) }));
    const count = await mount(useFactoryAttentionCount);
    expect(count.current).toBe(0);
  });

  it("is the number of open attention items once the status is ready", async () => {
    __setFactoryApiForTests(api({ status: async () => status(3) }));
    const count = await mount(useFactoryAttentionCount);
    expect(count.current).toBe(3);
  });

  it("is 0 when the first read fails, such as on a server without the factory", async () => {
    __setFactoryApiForTests(api({ status: notFound }));
    const count = await mount(useFactoryAttentionCount);
    expect(count.current).toBe(0);
  });

  it("keeps the last count when a later fetch fails", async () => {
    let fail = false;
    __setFactoryApiForTests(
      api({
        status: async () => {
          if (fail) throw new Error("down");
          return status(2);
        },
      }),
    );
    const count = await mount(useFactoryAttentionCount);
    expect(count.current).toBe(2);
    fail = true;
    await settle(30_000);
    expect(count.current).toBe(2);
  });
});

describe("useFactorySupported", () => {
  it("is true before any answer and once the status is ready", async () => {
    const pending = deferred<ReturnType<typeof status>>();
    __setFactoryApiForTests(api({ status: () => pending.promise }));
    const supported = await mount(useFactorySupported);
    expect(supported.current).toBe(true);
    await act(async () => pending.resolve(status(0)));
    expect(supported.current).toBe(true);
  });

  it("is false once the status answered 404, and true on any other failure", async () => {
    __setFactoryApiForTests(api({ status: notFound }));
    const supported = await mount(useFactorySupported);
    expect(supported.current).toBe(false);
    unmountAll();
    __resetFactoryStoresForTests();
    __setFactoryApiForTests(
      api({
        status: async () => {
          throw new FactoryApiError(503, null, "down");
        },
      }),
    );
    const down = await mount(useFactorySupported);
    expect(down.current).toBe(true);
  });
});

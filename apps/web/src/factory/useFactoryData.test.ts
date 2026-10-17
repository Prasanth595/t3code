import { createElement, act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { __setFactoryApiForTests, FactoryApiError, type FactoryApi } from "./api";
import {
  useFactoryAttentionCount,
  useFactoryRun,
  useFactoryRuns,
  useFactoryStatus,
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  unmountAll();
  __setFactoryApiForTests();
  vi.useRealTimers();
});

describe("useFactoryStatus", () => {
  it("is loading, then ready with the fetched status", async () => {
    let resolve!: (value: ReturnType<typeof status>) => void;
    __setFactoryApiForTests(api({ status: () => new Promise((r) => (resolve = r)) }));
    const result = await mount(useFactoryStatus);
    expect(result.current.status).toBe("loading");
    expect(result.current.data).toBeNull();
    await act(async () => resolve(status(2)));
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
    let resolve!: (value: ReturnType<typeof status>) => void;
    const fetchStatus = vi.fn(() => new Promise<ReturnType<typeof status>>((r) => (resolve = r)));
    __setFactoryApiForTests(api({ status: fetchStatus }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await mount(useFactoryStatus);
    unmountAll();
    await act(async () => resolve(status(1)));
    await settle(120_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
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

  it("is 0 on any error, such as an upstream server without the factory", async () => {
    __setFactoryApiForTests(
      api({
        status: async () => {
          throw new FactoryApiError(404, null, "Not found");
        },
      }),
    );
    const count = await mount(useFactoryAttentionCount);
    expect(count.current).toBe(0);
  });

  it("drops back to 0 when a later fetch fails", async () => {
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
    expect(count.current).toBe(0);
  });
});

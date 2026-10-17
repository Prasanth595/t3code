import { createElement, act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { __setFactoryApiForTests, FactoryApiError, type FactoryApi } from "./api";
import type { FactoryResource } from "./useFactoryData";
import { render } from "./testing";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");

const state = vi.hoisted(() => ({
  status: null as unknown,
  runs: null as unknown,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
  }: {
    to: string;
    params?: Record<string, string>;
    children?: ReactNode;
  }) =>
    createElement("a", { "data-to": to, "data-params": JSON.stringify(params ?? {}) }, children),
}));
vi.mock("./useFactoryData", () => ({
  useFactoryStatus: () => state.status,
  useFactoryRuns: () => state.runs,
}));

import { FactoryPage } from "./FactoryPage";

const resource = <T,>(overrides: Partial<FactoryResource<T>>): FactoryResource<T> => ({
  status: "ready",
  data: null,
  error: null,
  refresh: vi.fn(),
  ...overrides,
});

const statusData = (overrides: Record<string, unknown> = {}) => ({
  state: "running",
  reason: null,
  paused_by_hand: null,
  runs: [],
  attention: [],
  slots: { used: 1, max: 2 },
  passes: {},
  problems: [],
  ...overrides,
});

const RUN_ID = "original-solutions__t3code-factory__20__1";
const PR_URL = "https://github.com/original-solutions/t3code-factory/pull/30";
const runRow = (overrides: Record<string, unknown> = {}) => ({
  id: RUN_ID,
  started_ts: "2026-10-17T10:00:00.000Z",
  state: "building",
  last_event: "step_changed",
  step: "launch-sending",
  status: "running",
  pr_url: PR_URL,
  finished: false,
  total_ms: null,
  unreadable: false,
  ...overrides,
});

const api = (overrides: Partial<FactoryApi>): FactoryApi => ({
  status: vi.fn(),
  runs: vi.fn(),
  run: vi.fn(),
  stopRun: vi.fn(),
  pauseClaims: vi.fn(),
  resumeClaims: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.status = resource({ data: statusData() });
  state.runs = resource({ data: { runs: [] } });
});

afterEach(() => {
  __setFactoryApiForTests();
  vi.useRealTimers();
});

describe("FactoryPage", () => {
  it("says there are no runs yet when the factory has none", async () => {
    const page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("Factory");
    expect(page.text()).toContain("No runs yet");
    expect(page.text()).not.toContain("Needs attention");
  });

  it("shows a loading state while either read is loading", async () => {
    state.status = resource({ status: "loading" });
    const page = await render(createElement(FactoryPage));
    expect(
      page.renderer.root.findAll((n) => n.props["aria-label"] === "Loading factory"),
    ).not.toHaveLength(0);
    expect(page.text()).not.toContain("No runs yet");
  });

  it("shows the error and retries both reads", async () => {
    const refreshStatus = vi.fn();
    const refreshRuns = vi.fn();
    state.status = resource({ status: "ready", data: statusData(), refresh: refreshStatus });
    state.runs = resource({
      status: "error",
      error: new FactoryApiError(403, null, "Missing permission orchestration:read"),
      refresh: refreshRuns,
    });
    const page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("Missing permission orchestration:read");
    await act(async () => page.button("Retry")!.props.onClick());
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(refreshRuns).toHaveBeenCalledTimes(1);
  });

  it("lists the runs with repo, issue, state, step, age and pull request link", async () => {
    state.runs = resource({
      data: {
        runs: [
          runRow({ id: "acme__old__3__1", started_ts: "2026-10-16T12:00:00.000Z", state: "stuck" }),
          runRow(),
        ],
      },
    });
    const page = await render(createElement(FactoryPage));
    const text = page.text();
    expect(text).toContain("original-solutions/t3code-factory");
    expect(text).toContain("#20");
    expect(text).toContain("building");
    expect(text).toContain("launch-sending");
    expect(text).toContain("2h");
    const hrefs = page.all("a").map((a) => a.props.href);
    expect(hrefs).toContain("https://github.com/original-solutions/t3code-factory/issues/20");
    expect(hrefs).toContain(PR_URL);
    const link = page
      .all("a")
      .find(
        (a) => a.props["data-to"] === "/factory/$runId" && a.props["data-params"].includes(RUN_ID),
      );
    expect(link).toBeDefined();
  });

  it("lists the newest run first, and falls back to the last event without a step", async () => {
    state.runs = resource({
      data: {
        runs: [
          runRow({
            id: "acme__old__3__1",
            started_ts: "2026-10-16T12:00:00.000Z",
            step: null,
            last_event: "claimed",
          }),
          runRow(),
        ],
      },
    });
    const text = (await render(createElement(FactoryPage))).text();
    expect(text.indexOf("original-solutions/t3code-factory")).toBeLessThan(
      text.indexOf("acme/old"),
    );
    expect(text).toContain("claimed");
  });

  it("marks an unreadable run", async () => {
    state.runs = resource({
      data: { runs: [runRow({ unreadable: true, state: null, step: null, last_event: null })] },
    });
    expect((await render(createElement(FactoryPage))).text()).toContain("unreadable");
  });

  it("shows the open attention items at the top", async () => {
    state.status = resource({
      data: statusData({
        attention: [
          {
            id: "stuck:20",
            kind: "stuck",
            repo: "original-solutions/t3code-factory",
            issue: 20,
            run: RUN_ID,
            message: "run ended stuck: the gate failed",
            first_seen: "2026-10-17T11:00:00.000Z",
          },
        ],
      }),
    });
    state.runs = resource({ data: { runs: [runRow()] } });
    const text = (await render(createElement(FactoryPage))).text();
    expect(text).toContain("stuck");
    expect(text).toContain("original-solutions/t3code-factory#20");
    expect(text).toContain("run ended stuck: the gate failed");
    expect(text).toContain("1h");
    expect(text.indexOf("run ended stuck")).toBeLessThan(text.indexOf("launch-sending"));
  });

  it("shows an idle factory with its reason", async () => {
    state.status = resource({
      data: statusData({ state: "idle", reason: "no factory config" }),
    });
    const text = (await render(createElement(FactoryPage))).text();
    expect(text).toContain("idle");
    expect(text).toContain("no factory config");
  });

  it("pauses claims, shows the answer and refreshes", async () => {
    const refreshStatus = vi.fn();
    state.status = resource({ data: statusData(), refresh: refreshStatus });
    const pauseClaims = vi.fn(async () => ({
      paused: true as const,
      already: false,
      since: "2026-10-17T12:00:00.000Z",
      message: "claims paused",
    }));
    __setFactoryApiForTests(api({ pauseClaims }));
    const page = await render(createElement(FactoryPage));
    expect(page.button("Resume claims")).toBeUndefined();
    await act(async () => page.button("Pause claims")!.props.onClick());
    expect(pauseClaims).toHaveBeenCalledTimes(1);
    expect(page.text()).toContain("claims paused");
    expect(refreshStatus).toHaveBeenCalled();
  });

  it("resumes claims when they are paused by hand, saying since when", async () => {
    state.status = resource({
      data: statusData({
        paused_by_hand: { since: "2026-10-17T11:00:00.000Z", for_ms: 3_600_000 },
      }),
    });
    const resumeClaims = vi.fn(async () => ({
      paused: false as const,
      already: false,
      message: "claims resumed",
    }));
    __setFactoryApiForTests(api({ resumeClaims }));
    const page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("paused since 1h");
    expect(page.button("Pause claims")).toBeUndefined();
    await act(async () => page.button("Resume claims")!.props.onClick());
    expect(resumeClaims).toHaveBeenCalledTimes(1);
    expect(page.text()).toContain("claims resumed");
  });

  it("shows the message of a control call that fails", async () => {
    __setFactoryApiForTests(
      api({
        pauseClaims: async () => {
          throw new FactoryApiError(403, null, "Missing permission orchestration:operate");
        },
      }),
    );
    const page = await render(createElement(FactoryPage));
    await act(async () => page.button("Pause claims")!.props.onClick());
    expect(page.text()).toContain("Missing permission orchestration:operate");
  });
});

import { createElement, act, type ReactNode } from "react";
import type { ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { __setFactoryApiForTests, FactoryApiError, type FactoryApi } from "./api";
import type { FactoryResource } from "./useFactoryData";
import { render, renderAt } from "./testing";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");

const state = vi.hoisted(() => ({
  status: null as unknown,
  runs: null as unknown,
  allRuns: null as unknown,
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
  useFactoryRuns: (all?: boolean) => (all ? state.allRuns : state.runs),
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
  state.allRuns = state.runs;
});

afterEach(() => {
  __setFactoryApiForTests();
  vi.useRealTimers();
});

describe("FactoryPage", () => {
  it("says there are no runs yet when the factory has none", async () => {
    const page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("Factory");
    expect(page.text()).toContain("No runs in the last week");
    expect(page.text()).not.toContain("Needs attention");
    await act(async () => page.button("Show all runs")!.props.onClick());
    expect(page.text()).toContain("No runs yet");
  });

  it("shows a loading state while either read is loading", async () => {
    state.status = resource({ status: "loading" });
    const page = await render(createElement(FactoryPage));
    expect(
      page.renderer.root.findAll((n) => n.props["aria-label"] === "Loading factory"),
    ).not.toHaveLength(0);
    expect(page.text()).not.toContain("No runs");
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

  it("keeps the page when a later poll fails, with the error as a notice and a Retry", async () => {
    const refreshStatus = vi.fn();
    const refreshRuns = vi.fn();
    state.status = resource({ data: statusData(), refresh: refreshStatus });
    state.runs = resource({
      status: "error",
      data: { runs: [runRow()] },
      error: new Error("fetch failed"),
      refresh: refreshRuns,
    });
    const page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("original-solutions/t3code-factory");
    expect(page.text()).toContain("fetch failed");
    expect(page.text()).not.toContain("Could not load the factory");
    await act(async () => page.button("Retry")!.props.onClick());
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(refreshRuns).toHaveBeenCalledTimes(1);
  });

  it("lists the week the server sent, and every run once asked", async () => {
    const old = runRow({
      id: "o__r__1__1",
      started_ts: "2026-09-01T10:00:00.000Z",
      finished: true,
    });
    state.runs = resource({ data: { runs: [runRow()] } });
    state.allRuns = resource({ data: { runs: [runRow(), old] } });
    const page = await render(createElement(FactoryPage));
    const runLinks = () => page.all("a").filter((a) => a.props["data-to"] === "/factory/$runId");
    expect(runLinks()).toHaveLength(1);
    await act(async () => page.button("Show all runs")!.props.onClick());
    expect(runLinks()).toHaveLength(2);
    expect(page.text()).toContain("o__r__1__1");
    expect(page.text()).toContain("Every run, read once.");
    expect(page.button("Show all runs")).toBeUndefined();
    await act(async () => page.button("Show recent runs")!.props.onClick());
    expect(runLinks()).toHaveLength(1);
  });

  it("says when the week holds no runs and still offers every run", async () => {
    const page = await render(createElement(FactoryPage));
    expect(page.text()).toContain("No runs in the last week");
    expect(page.button("Show all runs")).toBeDefined();
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

  it("links a pull request only when it is a github.com URL", async () => {
    state.runs = resource({
      data: {
        runs: [
          runRow({ id: "acme__a__1__1", pr_url: "javascript:alert(1)" }),
          runRow({ id: "acme__b__2__1", pr_url: "https://evil.example/pull/9" }),
          runRow(),
        ],
      },
    });
    const page = await render(createElement(FactoryPage));
    const hrefs = page.all("a").map((a) => a.props.href);
    expect(hrefs).toContain(PR_URL);
    expect(hrefs).not.toContain("javascript:alert(1)");
    expect(hrefs).not.toContain("https://evil.example/pull/9");
    expect(page.text()).toContain("javascript:alert(1)");
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

  it("disables Pause claims while the call is pending", async () => {
    state.status = resource({ data: statusData() });
    let resolve!: (value: {
      paused: true;
      already: boolean;
      since: string;
      message: string;
    }) => void;
    const pauseClaims = vi.fn(
      () =>
        new Promise<{ paused: true; already: boolean; since: string; message: string }>(
          (r) => (resolve = r),
        ),
    );
    __setFactoryApiForTests(api({ pauseClaims }));
    const page = await render(createElement(FactoryPage));
    expect(page.button("Pause claims")!.props.disabled).toBeFalsy();
    await act(async () => void page.button("Pause claims")!.props.onClick());
    expect(page.button("Pause claims")!.props.disabled).toBe(true);
    await act(async () =>
      resolve({ paused: true, already: false, since: "2026-10-17T12:00:00.000Z", message: "ok" }),
    );
    expect(page.button("Pause claims")!.props.disabled).toBeFalsy();
  });

  it("disables Resume claims while the call is pending", async () => {
    state.status = resource({
      data: statusData({
        paused_by_hand: { since: "2026-10-17T11:00:00.000Z", for_ms: 3_600_000 },
      }),
    });
    let resolve!: (value: { paused: false; already: boolean; message: string }) => void;
    const resumeClaims = vi.fn(
      () => new Promise<{ paused: false; already: boolean; message: string }>((r) => (resolve = r)),
    );
    __setFactoryApiForTests(api({ resumeClaims }));
    const page = await render(createElement(FactoryPage));
    expect(page.button("Resume claims")!.props.disabled).toBeFalsy();
    await act(async () => void page.button("Resume claims")!.props.onClick());
    expect(page.button("Resume claims")!.props.disabled).toBe(true);
    await act(async () => resolve({ paused: false, already: false, message: "ok" }));
    expect(page.button("Resume claims")!.props.disabled).toBeFalsy();
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

const ATTENTION = {
  id: "stuck:20",
  kind: "stuck",
  repo: "original-solutions/t3code-factory",
  issue: 20,
  run: RUN_ID,
  message: "run ended stuck: the gate failed",
  first_seen: "2026-10-17T11:00:00.000Z",
};

describe.each([375, 1280])("FactoryPage at %i px", (width) => {
  const narrow = width < 640;
  const populate = () => {
    state.status = resource({ data: statusData({ attention: [ATTENTION] }) });
    state.runs = resource({
      status: "error",
      error: new Error("fetch failed"),
      data: {
        runs: [runRow(), runRow({ id: "acme__old__3__1", started_ts: "2026-10-16T12:00:00.000Z" })],
      },
    });
  };

  it(narrow ? "lists the runs as cards, not a table" : "lists the runs in a table", async () => {
    populate();
    const page = await renderAt(width, createElement(FactoryPage));
    expect(page.all("table")).toHaveLength(narrow ? 0 : 1);
    const cards = page.all("ul").filter((ul) => ul.props["data-layout"] === "cards");
    expect(cards).toHaveLength(narrow ? 1 : 0);
    await page.unmount();
  });

  it("puts the attention items above the runs", async () => {
    populate();
    const page = await renderAt(width, createElement(FactoryPage));
    const text = page.text();
    expect(text.indexOf("run ended stuck")).toBeGreaterThan(-1);
    expect(text.indexOf("run ended stuck")).toBeLessThan(text.indexOf("launch-sending"));
    expect(text.indexOf("Could not refresh")).toBeGreaterThan(text.indexOf("run ended stuck"));
    expect(text.indexOf("Could not refresh")).toBeLessThan(text.indexOf("launch-sending"));
    await page.unmount();
  });

  it("shows a control's answer in the body, below the attention items", async () => {
    populate();
    __setFactoryApiForTests(
      api({
        pauseClaims: async () => ({
          paused: true as const,
          already: false,
          since: "2026-10-17T12:00:00.000Z",
          message: "claims paused",
        }),
      }),
    );
    const page = await renderAt(width, createElement(FactoryPage));
    await act(async () => page.button("Pause claims")!.props.onClick());
    const text = page.text();
    expect(text.indexOf("claims paused")).toBeGreaterThan(text.indexOf("run ended stuck"));
    expect(text.indexOf("claims paused")).toBeLessThan(text.indexOf("launch-sending"));
    await page.unmount();
  });
});

describe("FactoryPage attention items at 375 px", () => {
  it("puts the message on its own full-width line after the badge, repo and age", async () => {
    state.status = resource({ data: statusData({ attention: [ATTENTION] }) });
    state.runs = resource({ data: { runs: [runRow()] } });
    const page = await renderAt(375, createElement(FactoryPage));
    const section = page
      .all("section")
      .find((node) => node.props["aria-label"] === "Needs attention")!;
    const item = section.findAllByType("li" as never)[0]!;
    const message = item.findAll(
      (node) => typeof node.type === "string" && node.children.includes(ATTENTION.message),
    )[0]!;
    expect(message.type).toBe("p");
    expect(String(message.props.className)).toContain("w-full");
    expect(String(message.props.className)).not.toContain("flex-1");
    const textOf = (node: ReactTestInstance | string): string =>
      typeof node === "string" ? node : node.children.map(textOf).join(" ");
    const full = textOf(item);
    const order = ["stuck", ATTENTION.repo, "1h", ATTENTION.message].map((part) =>
      full.indexOf(part),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    await page.unmount();
  });
});

describe("FactoryPage run cards at 375 px", () => {
  it("shows each run's repo, issue, state, step, age and pull request, and links to the run", async () => {
    state.runs = resource({ data: { runs: [runRow()] } });
    const page = await renderAt(375, createElement(FactoryPage));
    const link = page
      .all("a")
      .find(
        (a) => a.props["data-to"] === "/factory/$runId" && a.props["data-params"].includes(RUN_ID),
      );
    expect(link).toBeDefined();
    const text = link!
      .findAll(() => true)
      .flatMap((n) => n.children.filter((c) => typeof c === "string"))
      .join(" ");
    for (const part of ["original-solutions/t3code-factory", "building", "launch-sending", "2h"]) {
      expect(text).toContain(part);
    }
    // A card is one link: nothing inside it is another link.
    expect(link!.findAllByType("a" as never)).toHaveLength(1);
    await page.unmount();
  });

  it("links the issue and the pull request outside the card's own link", async () => {
    state.runs = resource({ data: { runs: [runRow()] } });
    const page = await renderAt(375, createElement(FactoryPage));
    const hrefs = page
      .all("a")
      .filter((a) => typeof a.props.href === "string")
      .map((a) => a.props.href);
    expect(hrefs).toEqual([
      "https://github.com/original-solutions/t3code-factory/issues/20",
      PR_URL,
    ]);
    const card = page.all("a").find((a) => a.props["data-to"] === "/factory/$runId")!;
    expect(card.findAllByType("a" as never)).toHaveLength(1);
    await page.unmount();
  });

  it("leaves a non-GitHub pull request URL as text on the card", async () => {
    state.runs = resource({ data: { runs: [runRow({ pr_url: "https://example.com/pr/1" })] } });
    const page = await renderAt(375, createElement(FactoryPage));
    expect(page.all("a").map((a) => a.props.href)).not.toContain("https://example.com/pr/1");
    expect(page.text()).toContain("https://example.com/pr/1");
    await page.unmount();
  });

  it("keeps the newest first, the empty state and the Show all runs control", async () => {
    state.runs = resource({
      data: {
        runs: [runRow({ id: "acme__old__3__1", started_ts: "2026-10-16T12:00:00.000Z" }), runRow()],
      },
    });
    const page = await renderAt(375, createElement(FactoryPage));
    const text = page.text();
    expect(text.indexOf("original-solutions/t3code-factory")).toBeLessThan(
      text.indexOf("acme/old"),
    );
    expect(page.button("Show all runs")).toBeDefined();
    await page.unmount();
    state.runs = resource({ data: { runs: [] } });
    const empty = await renderAt(375, createElement(FactoryPage));
    expect(empty.text()).toContain("No runs in the last week");
    expect(empty.button("Show all runs")).toBeDefined();
    await empty.unmount();
  });
});

describe.each([
  [639, true],
  [640, false],
])("FactoryPage at the 640 px breakpoint, %i px", (width, narrow) => {
  it(narrow ? "lists cards just below 640" : "lists the table from 640", async () => {
    state.runs = resource({ data: { runs: [runRow()] } });
    const page = await renderAt(width, createElement(FactoryPage));
    expect(page.all("table")).toHaveLength(narrow ? 0 : 1);
    const cards = page.all("ul").filter((ul) => ul.props["data-layout"] === "cards");
    expect(cards).toHaveLength(narrow ? 1 : 0);
    await page.unmount();
  });
});

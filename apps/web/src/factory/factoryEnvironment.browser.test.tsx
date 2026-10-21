import { createElement, act, type ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { __setFactoryApiForTests, FactoryApiError, type FactoryApi } from "./api";
import { render, resetDocumentVisible, setDocumentVisible } from "./testing";
import { __resetFactoryStoresForTests, useFactorySupported } from "./useFactoryData";

// The real hooks and pages over a fake API with one world per environment: which environments the
// pages read, show and call is the behavior under test.

const catalog = vi.hoisted(() => ({
  primary: null as string | null,
  connected: [] as string[],
  labels: new Map<string, string>(),
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => catalog.primary,
  useConnectedEnvironmentIds: () => catalog.connected,
  useEnvironments: () => ({
    presentationById: new Map(
      [...catalog.labels].map(([id, label]) => [id, { entry: { target: { label } } }]),
    ),
  }),
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

import { FactoryNavIcon } from "./FactoryNavIcon";
import { FactoryPage } from "./FactoryPage";
import { FactoryRunPage } from "./FactoryRunPage";

const ENV_1 = "env-1" as EnvironmentId;
const ENV_2 = "env-2" as EnvironmentId;

const RUN_1 = "original-solutions__t3code-factory__20__1";
const RUN_2 = "acme__widgets__7__1";

const attentionItem = (
  id: string,
  message: string,
  firstSeen: string,
  run: string | null = null,
) => ({
  id,
  kind: "stuck",
  repo: null,
  issue: null,
  run,
  message,
  first_seen: firstSeen,
});

const statusBody = (
  state: "running" | "idle",
  extra: { reason?: string | null; attention?: unknown[]; paused?: boolean } = {},
) => ({
  state,
  reason: extra.reason ?? null,
  paused_by_hand: extra.paused ? { since: "2026-10-17T11:00:00.000Z", for_ms: 3_600_000 } : null,
  runs: [],
  attention: extra.attention ?? [],
  slots: { used: 0, max: 1 },
  passes: {},
  problems: [],
});
const runRow = (id: string, started: string) => ({
  id,
  started_ts: started,
  state: "building",
  last_event: "session_launched",
  step: "launch-sending",
  status: "running",
  pr_url: null,
  finished: false,
  total_ms: null,
  unreadable: false,
});
const runDetail = (id: string) => ({
  id,
  entries: [
    {
      ts: "2026-10-17T10:00:01.000Z",
      ms: 1,
      event: "session_launched",
      data: { thread_id: "thread-9", worktree: "/w", branch: "b" },
      cause: null,
    },
    {
      ts: "2026-10-17T10:00:02.000Z",
      ms: 2,
      event: "state_changed",
      data: { from: "triage", to: "building" },
      cause: null,
    },
  ],
  truncated: false,
  skipped: 0,
});

/** What each environment's server says. An environment with no world answers 404, as an upstream build does. */
const worlds = new Map<
  string,
  { status: unknown; runs: ReadonlyArray<ReturnType<typeof runRow>>; hang?: boolean }
>();
const calls = {
  pause: [] as string[],
  resume: [] as string[],
  dismiss: [] as Array<[string, ReadonlyArray<string>]>,
  stop: [] as Array<[string, string]>,
  runRead: [] as Array<[string, string]>,
  runs: [] as Array<[string, boolean]>,
};

const worldOf = (environmentId: string) => {
  const world = worlds.get(environmentId);
  if (world === undefined) throw new FactoryApiError(404, null, "Not found");
  return world;
};
const never = <T,>() => new Promise<T>(() => {});

const fakeApi: FactoryApi = {
  status: async (env) => {
    const world = worldOf(env);
    return world.hang ? never<never>() : (world.status as never);
  },
  runs: async (env, { all }) => {
    calls.runs.push([env, all]);
    return { runs: worldOf(env).runs } as never;
  },
  run: async (env, id) => {
    calls.runRead.push([env, id]);
    return runDetail(id) as never;
  },
  stopRun: async (env, id) => {
    calls.stop.push([env, id]);
    return { message: "stopping" } as never;
  },
  pauseClaims: async (env) => {
    calls.pause.push(env);
    return { paused: true, already: false, since: "2026-10-17T12:00:00.000Z", message: "paused" };
  },
  resumeClaims: async (env) => {
    calls.resume.push(env);
    return { paused: false, already: false, message: "resumed" };
  },
  dismissAttention: async (env, ids) => {
    calls.dismiss.push([env, ids]);
    return { dismissed: ids };
  },
};

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
};

type Page = Awaited<ReturnType<typeof render>>;
const linksTo = (page: Page, to: string) =>
  page
    .all("a")
    .filter((a) => a.getAttribute("data-to") === to)
    .map((a) => JSON.parse(a.getAttribute("data-params")!) as Record<string, string>);

let mounted: Page[] = [];
const show = async (element: Parameters<typeof render>[0]) => {
  const page = await render(element);
  mounted.push(page);
  await settle();
  return page;
};

/** The status row of one environment: the block that holds its label and its Pause/Resume button. */
const rowOf = (page: Page, label: string) =>
  page
    .all("*")
    .findLast(
      (node) =>
        node.querySelector("button") !== null &&
        node.textContent?.includes(label) === true &&
        !node.textContent.includes("Show all runs") &&
        Array.from(node.querySelectorAll("button")).every((b) =>
          /claims|Retry/.test(b.textContent ?? ""),
        ),
    )!;
const buttonIn = (row: Element, label: string) =>
  Array.from(row.querySelectorAll("button")).find((b) => b.textContent === label)!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-17T12:00:00.000Z"));
  setDocumentVisible(true);
  catalog.primary = ENV_1;
  catalog.connected = [ENV_1, ENV_2];
  catalog.labels = new Map([
    [ENV_1, "Desktop"],
    [ENV_2, "Studio"],
  ]);
  worlds.set(ENV_1, {
    status: statusBody("running"),
    runs: [runRow(RUN_1, "2026-10-17T10:00:00.000Z")],
  });
  worlds.set(ENV_2, {
    status: statusBody("running"),
    runs: [runRow(RUN_2, "2026-10-17T11:00:00.000Z")],
  });
  __setFactoryApiForTests(fakeApi);
});

afterEach(async () => {
  for (const page of mounted) await page.unmount();
  mounted = [];
  __resetFactoryStoresForTests();
  __setFactoryApiForTests();
  worlds.clear();
  for (const list of Object.values(calls)) list.length = 0;
  resetDocumentVisible();
  vi.useRealTimers();
});

describe("the Factory page shows every environment that runs a factory", () => {
  it("lists both factories' runs with their environments, each run linking to its own", async () => {
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("original-solutions/t3code-factory");
    expect(page.text()).toContain("acme/widgets");
    expect(page.text()).toContain("Environment");
    expect(page.text()).toContain("Desktop");
    expect(page.text()).toContain("Studio");
    expect(linksTo(page, "/factory/$environmentId/$runId")).toEqual(
      expect.arrayContaining([
        { environmentId: ENV_1, runId: RUN_1 },
        { environmentId: ENV_2, runId: RUN_2 },
      ]),
    );
    // Newest first across environments.
    expect(page.text().indexOf("acme/widgets")).toBeLessThan(
      page.text().indexOf("original-solutions/t3code-factory"),
    );
  });

  it("shows no Environment column when only one environment runs a factory", async () => {
    catalog.connected = [ENV_1];
    worlds.delete(ENV_2);
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("original-solutions/t3code-factory");
    expect(page.all("th").map((th) => th.textContent)).not.toContain("Environment");
  });

  it("reads every environment's full list once when asked for all runs", async () => {
    const page = await show(createElement(FactoryPage));
    await page.click(page.button("Show all runs")!);
    await settle();
    expect(
      calls.runs
        .filter(([, all]) => all)
        .map(([env]) => env)
        .sort(),
    ).toEqual([ENV_1, ENV_2]);
  });

  it("sums the open attention items of both environments on the badge", async () => {
    worlds.get(ENV_1)!.status = statusBody("running", {
      attention: [attentionItem("a", "one", "2026-10-17T10:00:00.000Z")],
    });
    worlds.get(ENV_2)!.status = statusBody("running", {
      attention: [
        attentionItem("b", "two", "2026-10-17T10:30:00.000Z"),
        attentionItem("c", "three", "2026-10-17T10:40:00.000Z"),
      ],
    });
    const badge = await show(createElement(FactoryNavIcon));
    expect(badge.text()).toBe("3");
  });

  it("pauses only the environment whose row was clicked", async () => {
    const page = await show(createElement(FactoryPage));
    await page.click(buttonIn(rowOf(page, "Studio"), "Pause claims"));
    expect(calls.pause).toEqual([ENV_2]);
    expect(buttonIn(rowOf(page, "Desktop"), "Pause claims").disabled).toBe(false);
  });

  it("resumes a paused environment and says since when on its row only", async () => {
    worlds.get(ENV_2)!.status = statusBody("running", { paused: true });
    const page = await show(createElement(FactoryPage));
    expect(rowOf(page, "Studio").textContent).toContain("Claims paused since 1h");
    expect(rowOf(page, "Desktop").textContent).not.toContain("Claims paused");
    await page.click(buttonIn(rowOf(page, "Studio"), "Resume claims"));
    expect(calls.resume).toEqual([ENV_2]);
    expect(calls.pause).toEqual([]);
  });

  it("dismisses an item on its own environment, and Dismiss all splits the ids by environment", async () => {
    worlds.get(ENV_1)!.status = statusBody("running", {
      attention: [
        attentionItem("a1", "first one", "2026-10-17T10:00:00.000Z"),
        attentionItem("a2", "second one", "2026-10-17T10:20:00.000Z"),
      ],
    });
    worlds.get(ENV_2)!.status = statusBody("running", {
      attention: [attentionItem("b1", "third one", "2026-10-17T10:10:00.000Z", RUN_2)],
    });
    const page = await show(createElement(FactoryPage));
    // Oldest first across environments.
    const text = page.text();
    expect(text.indexOf("first one")).toBeLessThan(text.indexOf("third one"));
    expect(text.indexOf("third one")).toBeLessThan(text.indexOf("second one"));
    // The run link of an item carries its environment.
    expect(linksTo(page, "/factory/$environmentId/$runId")).toContainEqual({
      environmentId: ENV_2,
      runId: RUN_2,
    });
    const item = page.all("li").find((li) => li.textContent?.includes("third one"))!;
    await page.click(
      Array.from(item.querySelectorAll("button")).find((b) => b.textContent === "Dismiss")!,
    );
    expect(calls.dismiss).toEqual([[ENV_2, ["b1"]]]);
    await page.click(page.button("Dismiss all")!);
    expect(calls.dismiss.slice(1)).toEqual([[ENV_1, ["a1", "a2"]]]);
  });

  it("splits Dismiss all by environment, one call each", async () => {
    worlds.get(ENV_1)!.status = statusBody("running", {
      attention: [attentionItem("same", "on desktop", "2026-10-17T10:00:00.000Z")],
    });
    worlds.get(ENV_2)!.status = statusBody("running", {
      attention: [attentionItem("same", "on studio", "2026-10-17T10:00:00.000Z")],
    });
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("on desktop");
    expect(page.text()).toContain("on studio");
    await page.click(page.button("Dismiss all")!);
    expect([...calls.dismiss].sort()).toEqual([
      [ENV_1, ["same"]],
      [ENV_2, ["same"]],
    ]);
    expect(page.text()).not.toContain("on desktop");
    expect(page.text()).not.toContain("on studio");
  });

  it("shows one row per environment: the primary's idle reason, and the second's runs", async () => {
    worlds.set(ENV_1, { status: statusBody("idle", { reason: "no repos" }), runs: [] });
    const page = await show(createElement(FactoryPage));
    expect(rowOf(page, "Desktop").textContent).toContain("Idle: no repos");
    expect(rowOf(page, "Studio").textContent).toContain("Running");
    expect(page.text()).toContain("acme/widgets");
  });

  it("lists only the second environment when the primary has no factory", async () => {
    worlds.delete(ENV_1);
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("acme/widgets");
    expect(page.text()).toContain("Studio");
    expect(page.text()).not.toContain("Desktop");
    expect(page.button("Pause claims")).toBeDefined();
    expect(page.all("button").filter((b) => b.textContent === "Pause claims")).toHaveLength(1);
  });

  it("shows the runs of the others while a candidate has not answered", async () => {
    worlds.set(ENV_1, { status: statusBody("running"), runs: [], hang: true });
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("acme/widgets");
    expect(rowOf(page, "Desktop").textContent).toContain("Loading");
  });

  it("names the environment whose runs could not be read, and keeps the rest", async () => {
    const runs = fakeApi.runs;
    __setFactoryApiForTests({
      ...fakeApi,
      runs: async (env, options) => {
        if (env === ENV_1) throw new FactoryApiError(500, null, "ledger exploded");
        return runs(env, options);
      },
    });
    const page = await show(createElement(FactoryPage));
    expect(page.text()).toContain("Could not refresh Desktop: ledger exploded");
    expect(page.text()).toContain("acme/widgets");
    expect(page.button("Retry")).toBeDefined();
  });
});

describe("the sidebar item follows the environments", () => {
  const Probe = () => String(useFactorySupported());
  const supported = async () => (await show(createElement(Probe))).text() === "true";

  it("stays when the primary has no factory and the second runs one", async () => {
    worlds.delete(ENV_1);
    expect(await supported()).toBe(true);
  });

  it("is hidden when every candidate answered 404", async () => {
    worlds.clear();
    expect(await supported()).toBe(false);
  });

  it("stays while a candidate has not answered", async () => {
    worlds.delete(ENV_1);
    worlds.set(ENV_2, { status: statusBody("running"), runs: [], hang: true });
    expect(await supported()).toBe(true);
  });
});

describe("the run page follows its environment", () => {
  it("reads, stops and links the thread on the environment it is given, and names it", async () => {
    const page = await show(createElement(FactoryRunPage, { environmentId: ENV_2, runId: RUN_2 }));
    expect(calls.runRead.length).toBeGreaterThan(0);
    expect(calls.runRead.every(([env, id]) => env === ENV_2 && id === RUN_2)).toBe(true);
    expect(page.text()).toContain("Studio");
    expect(linksTo(page, "/$environmentId/$threadId")).toEqual([
      { environmentId: ENV_2, threadId: "thread-9" },
    ]);
    await page.click(page.button("Stop")!);
    expect(calls.stop).toEqual([[ENV_2, RUN_2]]);
  });
});

import { createElement, act, type ReactNode } from "react";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession } from "~/state/session";

import { __setFactoryConnectionForTests } from "./api";
import { render, resetDocumentVisible, setDocumentVisible } from "./testing";
import { __resetFactoryStoresForTests } from "./useFactoryData";

// The real api, hooks and pages, with only the wire, the environment catalog and the router
// stubbed: which environment the pages call is the behavior under test.

const catalog = vi.hoisted(() => ({ primary: null as string | null, connected: [] as string[] }));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => catalog.primary,
  useConnectedEnvironmentIds: () => catalog.connected,
}));
vi.mock("~/state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const connections = new Map<string, Atom.Writable<Option.Option<PreparedConnection>>>();
  return {
    environmentSession: {
      preparedConnectionValueAtom: (environmentId: string) => {
        let atom = connections.get(environmentId);
        if (atom === undefined) {
          atom = Atom.make(Option.none<PreparedConnection>()).pipe(Atom.keepAlive);
          connections.set(environmentId, atom);
        }
        return atom;
      },
    },
  };
});
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

import { FactoryPage } from "./FactoryPage";
import { FactoryRunPage } from "./FactoryRunPage";

const ENV_1 = "env-1" as EnvironmentId;
const ENV_2 = "env-2" as EnvironmentId;
const PRIMARY_BASE = "http://127.0.0.1:3773";
const REMOTE_BASE = "https://personal-mac.tail1234.ts.net:3876";

const setConnectionOf = (environmentId: EnvironmentId, prepared: PreparedConnection) =>
  appAtomRegistry.set(
    environmentSession.preparedConnectionValueAtom(environmentId) as Atom.Writable<
      Option.Option<PreparedConnection>
    >,
    Option.some(prepared),
  );

const RUN_ID = "original-solutions__t3code-factory__20__1";

const statusBody = (state: "running" | "idle", reason: string | null = null) => ({
  state,
  reason,
  paused_by_hand: null,
  runs: [],
  attention: [],
  slots: { used: 0, max: 1 },
  passes: {},
  problems: [],
});
const runRow = {
  id: RUN_ID,
  started_ts: "2026-10-17T10:00:00.000Z",
  state: "building",
  last_event: "session_launched",
  step: "launch-sending",
  status: "running",
  pr_url: null,
  finished: false,
  total_ms: null,
  unreadable: false,
};
const runDetail = {
  id: RUN_ID,
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
};

/** What each server says, by origin: the status it reports, and the runs it lists. */
const servers = new Map<
  string,
  { readonly status: unknown; readonly runs: ReadonlyArray<typeof runRow> }
>();

const fetchMock = vi.fn<typeof fetch>(async (input) => {
  const url = new URL(String(input));
  const server = servers.get(url.origin);
  if (server === undefined) return new Response("{}", { status: 404 });
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  if (url.pathname === "/api/factory/status") return json(server.status);
  if (url.pathname === "/api/factory/runs") return json({ runs: server.runs });
  if (url.pathname === `/api/factory/runs/${RUN_ID}` && server.runs.length > 0) {
    return json(runDetail);
  }
  return new Response("{}", { status: 404 });
});

/** Every request the pages sent, as `[origin, path, authorization, credentials]`. */
const requests = () =>
  fetchMock.mock.calls.map(([input, init]) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    return [url.origin, url.pathname, headers.get("authorization"), init?.credentials] as const;
  });
const requestsTo = (path: string) => requests().filter(([, requested]) => requested === path);

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
};

const linkTo = (page: Awaited<ReturnType<typeof render>>, to: string) =>
  page.all("a").find((a) => a.getAttribute("data-to") === to);

let mounted: Array<Awaited<ReturnType<typeof render>>> = [];
const show = async (element: Parameters<typeof render>[0]) => {
  const page = await render(element);
  mounted.push(page);
  await settle();
  return page;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-17T12:00:00.000Z"));
  vi.stubGlobal("fetch", fetchMock);
  setDocumentVisible(true);
  catalog.primary = ENV_1;
  catalog.connected = [ENV_1, ENV_2];
  setConnectionOf(ENV_1, {
    httpBaseUrl: PRIMARY_BASE,
    httpAuthorization: null,
  } as unknown as PreparedConnection);
  setConnectionOf(ENV_2, {
    httpBaseUrl: `${REMOTE_BASE}/`,
    httpAuthorization: { _tag: "Bearer", token: "tok-2" },
  } as unknown as PreparedConnection);
  servers.set(PRIMARY_BASE, { status: statusBody("idle", "no repos"), runs: [] });
  servers.set(REMOTE_BASE, { status: statusBody("running"), runs: [runRow] });
});

afterEach(async () => {
  for (const page of mounted) await page.unmount();
  mounted = [];
  __resetFactoryStoresForTests();
  __setFactoryConnectionForTests();
  servers.clear();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  resetDocumentVisible();
  vi.useRealTimers();
});

describe("the Factory pages follow the environment that runs the factory", () => {
  it("shows the second environment's runs when the primary is idle and it is running", async () => {
    const page = await show(createElement(FactoryPage));
    const runs = requestsTo("/api/factory/runs");
    expect(runs.length).toBeGreaterThan(0);
    for (const request of runs) {
      expect(request).toEqual([REMOTE_BASE, "/api/factory/runs", "Bearer tok-2", "omit"]);
    }
    expect(page.text()).not.toContain("The factory is idle");
    expect(
      page
        .all("a")
        .some((a) => a.getAttribute("data-params") === JSON.stringify({ runId: RUN_ID })),
    ).toBe(true);
  });

  it("opens a run and links its thread on the second environment", async () => {
    await show(createElement(FactoryRunPage, { runId: RUN_ID }));
    const detail = requestsTo(`/api/factory/runs/${RUN_ID}`);
    expect(detail.length).toBeGreaterThan(0);
    for (const request of detail) {
      expect(request).toEqual([REMOTE_BASE, `/api/factory/runs/${RUN_ID}`, "Bearer tok-2", "omit"]);
    }
    const page = mounted[0]!;
    expect(
      JSON.parse(linkTo(page, "/$environmentId/$threadId")!.getAttribute("data-params")!),
    ).toEqual({
      environmentId: "env-2",
      threadId: "thread-9",
    });
  });

  it("calls only the primary when only the primary runs the factory", async () => {
    servers.set(PRIMARY_BASE, { status: statusBody("running"), runs: [runRow] });
    servers.set(REMOTE_BASE, { status: statusBody("idle", "no repos"), runs: [] });
    await show(createElement(FactoryPage));
    const runs = requestsTo("/api/factory/runs");
    expect(runs.length).toBeGreaterThan(0);
    for (const request of runs) {
      expect(request).toEqual([PRIMARY_BASE, "/api/factory/runs", null, "include"]);
    }
    await show(createElement(FactoryRunPage, { runId: RUN_ID }));
    const detail = requestsTo(`/api/factory/runs/${RUN_ID}`);
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.every(([origin]) => origin === PRIMARY_BASE)).toBe(true);
    expect(
      JSON.parse(linkTo(mounted[1]!, "/$environmentId/$threadId")!.getAttribute("data-params")!),
    ).toEqual({ environmentId: "env-1", threadId: "thread-9" });
  });

  it("shows the primary's idle reason when no connected environment runs the factory", async () => {
    catalog.connected = [ENV_1];
    servers.set(REMOTE_BASE, { status: statusBody("running"), runs: [runRow] });
    const page = await show(createElement(FactoryPage));
    expect(requestsTo("/api/factory/runs").every(([origin]) => origin === PRIMARY_BASE)).toBe(true);
    expect(page.text()).toContain("The factory is idle: no repos");
  });
});

import { describe, expect, it, vi } from "vite-plus/test";

import {
  FACTORY_BEFORE_CONTENT_LOADED_SCRIPT,
  factoryExchangeScript,
} from "./factoryWebViewScripts";

const ORIGIN = "https://mac.tail1234.ts.net";

type ExchangeFetch = (url: string, init: { body: string }) => Promise<{ ok: boolean }>;

function runExchange(locationOrigin: string, respond: ExchangeFetch = async () => ({ ok: true })) {
  const fetched: Array<{ url: string; body: string }> = [];
  const posted: unknown[] = [];
  const replaced: string[] = [];
  const window = {
    location: { origin: locationOrigin, replace: (url: string) => replaced.push(url) },
    ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) },
  };
  const fetchFn: ExchangeFetch = (url, init) => {
    fetched.push({ url, body: init.body });
    return respond(url, init);
  };
  new Function("window", "fetch", factoryExchangeScript("cred-1", ORIGIN))(window, fetchFn);
  return { fetched, posted, replaced };
}

// Every exchange ends by posting exactly one result, so that post marks it settled.
async function settled(run: { posted: unknown[] }) {
  await vi.waitFor(() => expect(run.posted).toHaveLength(1));
}

describe("factoryExchangeScript", () => {
  it("posts the credential on the server origin", async () => {
    const run = runExchange(ORIGIN);
    await settled(run);
    expect(run.fetched).toHaveLength(1);
    expect(run.fetched[0]?.url).toBe("/api/auth/browser-session");
    expect(run.fetched[0]?.body).toContain("cred-1");
    expect(run.posted).toEqual([{ type: "exchange", ok: true }]);
    expect(run.replaced).toEqual(["/factory"]);
  });

  it("never sends the credential from another origin", async () => {
    const run = runExchange("https://evil.example");
    await settled(run);
    expect(run.fetched).toHaveLength(0);
    expect(run.posted).toEqual([{ type: "exchange", ok: false }]);
    expect(run.replaced).toEqual([]);
  });

  it("reports a refused credential and stays on the page", async () => {
    const run = runExchange(ORIGIN, async () => ({ ok: false }));
    await settled(run);
    expect(run.fetched).toHaveLength(1);
    expect(run.posted).toEqual([{ type: "exchange", ok: false }]);
    expect(run.replaced).toEqual([]);
  });

  it("reports a failed request and stays on the page", async () => {
    const run = runExchange(ORIGIN, async () => {
      throw new TypeError("Network request failed");
    });
    await settled(run);
    expect(run.posted).toEqual([{ type: "exchange", ok: false }]);
    expect(run.replaced).toEqual([]);
  });
});

type Posted = { type: string; href?: string };

function runBridge(href: string, status = 200) {
  const posted: Posted[] = [];
  const listeners: Record<string, () => void> = {};
  const window: Record<string, unknown> = {
    location: { href, origin: new URL(href).origin },
    ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) },
    addEventListener: (name: string, listener: () => void) => {
      listeners[name] = listener;
    },
    fetch: async () => ({ status, ok: status >= 200 && status < 300 }),
  };
  const originalCalls: Array<{ name: string; self: unknown; args: unknown[] }> = [];
  const history = {
    pushState(...args: unknown[]) {
      originalCalls.push({ name: "pushState", self: this, args });
    },
    replaceState(...args: unknown[]) {
      originalCalls.push({ name: "replaceState", self: this, args });
    },
  };
  new Function("window", "history", FACTORY_BEFORE_CONTENT_LOADED_SCRIPT)(window, history);
  const navigate = (next: string) => {
    (window.location as { href: string }).href = next;
  };
  return { window, history, posted, listeners, originalCalls, navigate };
}

describe("location bridge", () => {
  it("reports the first location and every history change, and still runs the real history calls", () => {
    const run = runBridge(`${ORIGIN}/factory`);
    expect(run.posted).toEqual([{ type: "location", href: `${ORIGIN}/factory` }]);

    run.navigate(`${ORIGIN}/pair`);
    run.history.replaceState({ from: "router" }, "", "/pair");
    run.navigate(`${ORIGIN}/pair/#token=abc`);
    run.history.pushState(null, "", "/pair/#token=abc");
    run.navigate(`${ORIGIN}/factory/runs/1`);
    run.listeners.popstate?.();

    expect(run.posted.map((message) => message.href)).toEqual([
      `${ORIGIN}/factory`,
      `${ORIGIN}/pair`,
      `${ORIGIN}/pair/#token=abc`,
      `${ORIGIN}/factory/runs/1`,
    ]);
    expect(run.originalCalls).toEqual([
      { name: "replaceState", self: run.history, args: [{ from: "router" }, "", "/pair"] },
      { name: "pushState", self: run.history, args: [null, "", "/pair/#token=abc"] },
    ]);
  });

  it("installs once per page", () => {
    const run = runBridge(`${ORIGIN}/factory`);
    new Function("window", "history", FACTORY_BEFORE_CONTENT_LOADED_SCRIPT)(
      run.window,
      run.history,
    );
    expect(run.posted).toHaveLength(1);
  });
});

describe("fetch hook", () => {
  async function run(input: unknown, status = 401) {
    const bridge = runBridge(`${ORIGIN}/factory`, status);
    await (bridge.window.fetch as (input: unknown) => Promise<unknown>)(input);
    return bridge.posted.filter((m) => m.type !== "location").map((m) => m.type);
  }

  it("reports a 401 for string, URL and Request inputs", async () => {
    const url = `${ORIGIN}/api/factory/status`;
    expect(await run(url)).toEqual(["unauthorized"]);
    expect(await run(new URL(url))).toEqual(["unauthorized"]);
    expect(await run(new Request(url))).toEqual(["unauthorized"]);
    expect(await run("/api/factory/status")).toEqual(["unauthorized"]);
  });

  it("reports an accepted cookie once the status call succeeds", async () => {
    expect(await run(`${ORIGIN}/api/factory/status`, 200)).toEqual(["authorized"]);
  });

  it("ignores other paths, other origins and other statuses", async () => {
    expect(await run(`${ORIGIN}/api/other`)).toEqual([]);
    expect(await run(`${ORIGIN}/api/other`, 200)).toEqual([]);
    expect(await run("https://other.example/api/factory/status")).toEqual([]);
    expect(await run(`${ORIGIN}/x?/api/factory/status`)).toEqual([]);
    expect(await run(`${ORIGIN}/api/factory/status`, 500)).toEqual([]);
    expect(await run(`${ORIGIN}/api/factory/status`, 403)).toEqual([]);
  });
});

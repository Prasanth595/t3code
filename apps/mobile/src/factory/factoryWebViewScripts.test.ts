import { describe, expect, it } from "vite-plus/test";

import {
  FACTORY_BEFORE_CONTENT_LOADED_SCRIPT,
  factoryExchangeScript,
} from "./factoryWebViewScripts";

const ORIGIN = "https://mac.tail1234.ts.net";

function runExchange(locationOrigin: string) {
  const fetched: Array<{ url: string; body: string }> = [];
  const posted: unknown[] = [];
  const replaced: string[] = [];
  const window = {
    location: { origin: locationOrigin, replace: (url: string) => replaced.push(url) },
    ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) },
  };
  const fetchFn = async (url: string, init: { body: string }) => {
    fetched.push({ url, body: init.body });
    return { ok: true };
  };
  new Function("window", "fetch", factoryExchangeScript("cred-1", ORIGIN))(window, fetchFn);
  return { fetched, posted, replaced };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("factoryExchangeScript", () => {
  it("posts the credential on the server origin", async () => {
    const run = runExchange(ORIGIN);
    await settle();
    expect(run.fetched).toHaveLength(1);
    expect(run.fetched[0]?.url).toBe("/api/auth/browser-session");
    expect(run.fetched[0]?.body).toContain("cred-1");
    expect(run.posted).toEqual([{ type: "exchange", ok: true }]);
    expect(run.replaced).toEqual(["/factory"]);
  });

  it("never sends the credential from another origin", async () => {
    const run = runExchange("https://evil.example");
    await settle();
    expect(run.fetched).toHaveLength(0);
    expect(run.posted).toEqual([{ type: "exchange", ok: false }]);
    expect(run.replaced).toEqual([]);
  });
});

describe("fetch hook", () => {
  async function run(input: unknown, status = 401) {
    const posted: unknown[] = [];
    const window: Record<string, unknown> = {
      location: { href: `${ORIGIN}/factory`, origin: ORIGIN },
      ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) },
      addEventListener: () => undefined,
      fetch: async () => ({ status }),
    };
    const history = { pushState: () => undefined, replaceState: () => undefined };
    new Function("window", "history", FACTORY_BEFORE_CONTENT_LOADED_SCRIPT)(window, history);
    await (window.fetch as (input: unknown) => Promise<unknown>)(input);
    return posted.filter((m) => (m as { type: string }).type === "unauthorized");
  }

  it("reports a 401 for string, URL and Request inputs", async () => {
    const url = `${ORIGIN}/api/factory/status`;
    expect(await run(url)).toHaveLength(1);
    expect(await run(new URL(url))).toHaveLength(1);
    expect(await run(new Request(url))).toHaveLength(1);
    expect(await run("/api/factory/status")).toHaveLength(1);
  });

  it("ignores other paths, other origins and other statuses", async () => {
    expect(await run(`${ORIGIN}/api/other`)).toHaveLength(0);
    expect(await run("https://other.example/api/factory/status")).toHaveLength(0);
    expect(await run(`${ORIGIN}/x?/api/factory/status`)).toHaveLength(0);
    expect(await run(`${ORIGIN}/api/factory/status`, 200)).toHaveLength(0);
  });
});

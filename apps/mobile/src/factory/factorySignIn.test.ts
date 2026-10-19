import { describe, expect, it } from "vite-plus/test";

import {
  factoryLinkAction,
  factoryUrl,
  mintPairingToken,
  parseFactoryMessage,
  probeFactory,
  nextSignIn,
  type SignInState,
} from "./factorySignIn";

const BASE = "https://mac.tail1234.ts.net";
const SLASH_BASE = "https://mac.tail1234.ts.net:3876/";
const BEARER = "bearer-secret-123";
const CREDENTIAL = "credential-secret-456";
const server = { httpBaseUrl: BASE, bearerToken: BEARER };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("factoryLinkAction", () => {
  it.each([
    [`${BASE}/factory`, "webview"],
    [`${BASE}/factory/runs/3?x=1`, "webview"],
    [`${BASE}/pair`, "webview"],
    ["about:blank", "webview"],
    ["blob:https://mac.tail1234.ts.net/abc", "webview"],
    ["data:text/html,hi", "webview"],
    ["https://github.com/org/repo/pull/1", "system"],
    ["https://mac.tail1234.ts.net:8443/factory", "system"],
    ["http://mac.tail1234.ts.net/factory", "system"],
    ["mailto:a@b.co", "system"],
    ["tel:123", "system"],
    ["not a url", "system"],
  ])("%s -> %s", (url, expected) => {
    expect(factoryLinkAction(url, BASE)).toBe(expected);
  });

  it("matches the server's explicit port", () => {
    expect(factoryLinkAction("http://10.0.0.2:3876/factory", "http://10.0.0.2:3876")).toBe(
      "webview",
    );
    expect(factoryLinkAction("http://10.0.0.2:3877/factory", "http://10.0.0.2:3876")).toBe(
      "system",
    );
  });
});

describe("nextSignIn", () => {
  const pair = { type: "location", href: `${BASE}/pair` } as const;
  const factory = { type: "location", href: `${BASE}/factory/runs/1` } as const;
  const unauthorized = { type: "unauthorized" } as const;
  const step = (
    state: SignInState,
    event: Parameters<typeof nextSignIn>[1],
    eventUrl: string = `${BASE}/pair`,
  ) => nextSignIn(state, event, eventUrl, BASE);

  it("mints once when idle on the pair page, with or without a trailing slash", () => {
    expect(step("idle", pair)).toEqual({ state: "minting", action: "mint" });
    expect(step("idle", { type: "location", href: `${BASE}/pair/#token=x` })).toEqual({
      state: "minting",
      action: "mint",
    });
    expect(step("idle", unauthorized)).toEqual({ state: "minting", action: "mint" });
  });

  it("mints nothing when the WebView lands on /factory with a valid cookie", () => {
    expect(step("idle", factory, `${BASE}/factory`)).toEqual({ state: "idle", action: "none" });
    expect(step("idle", { type: "location", href: `${BASE}/settings` })).toEqual({
      state: "idle",
      action: "none",
    });
  });

  it("ignores duplicate signals while a sign-in is in flight", () => {
    expect(step("minting", unauthorized).action).toBe("none");
    expect(step("exchanging", pair).action).toBe("none");
    expect(step("minting", unauthorized).state).toBe("minting");
  });

  it("moves minting -> exchanging -> exchanged -> signed-in", () => {
    expect(step("minting", { type: "minted" })).toEqual({ state: "exchanging", action: "none" });
    expect(step("exchanging", { type: "exchange", ok: true })).toEqual({
      state: "exchanged",
      action: "none",
    });
    expect(step("exchanged", factory, `${BASE}/factory`)).toEqual({
      state: "signed-in",
      action: "none",
    });
  });

  it("fails instead of looping when unauthenticated after an accepted exchange", () => {
    expect(step("exchanged", pair).action).toBe("rejected");
    expect(step("exchanged", unauthorized).action).toBe("rejected");
  });

  it("signs in again when a signed-in session later ends", () => {
    expect(step("signed-in", unauthorized)).toEqual({ state: "minting", action: "mint" });
    expect(step("signed-in", pair)).toEqual({ state: "minting", action: "mint" });
  });

  it("reports a failed exchange", () => {
    expect(step("exchanging", { type: "exchange", ok: false })).toEqual({
      state: "idle",
      action: "exchange-failed",
    });
  });

  it("ignores exchange messages when no exchange was started", () => {
    expect(step("idle", { type: "exchange", ok: false }).action).toBe("none");
  });

  it("ignores messages whose top frame is not the server", () => {
    expect(step("idle", unauthorized, "https://evil.example/pair")).toEqual({
      state: "idle",
      action: "none",
    });
    expect(step("idle", pair, "about:blank").action).toBe("none");
    expect(
      step("exchanging", { type: "exchange", ok: false }, "https://evil.example/").action,
    ).toBe("none");
  });

  it("accepts a base URL with a trailing slash", () => {
    expect(nextSignIn("idle", unauthorized, `${BASE}/pair`, `${BASE}/`)).toEqual({
      state: "minting",
      action: "mint",
    });
  });
});

describe("parseFactoryMessage", () => {
  it("parses known messages and rejects the rest", () => {
    expect(
      parseFactoryMessage(JSON.stringify({ type: "location", href: `${BASE}/factory` })),
    ).toEqual({ type: "location", href: `${BASE}/factory` });
    expect(parseFactoryMessage(JSON.stringify({ type: "unauthorized" }))).toEqual({
      type: "unauthorized",
    });
    expect(parseFactoryMessage(JSON.stringify({ type: "exchange", ok: false }))).toEqual({
      type: "exchange",
      ok: false,
    });
    expect(parseFactoryMessage("nope")).toBeNull();
    expect(parseFactoryMessage(JSON.stringify({ type: "location" }))).toBeNull();
    expect(parseFactoryMessage(JSON.stringify(["location"]))).toBeNull();
    expect(parseFactoryMessage(JSON.stringify({ type: "other" }))).toBeNull();
  });
});

describe("mintPairingToken", () => {
  it("returns the credential and sends the bearer to the pairing endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await mintPairingToken(server, async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json(200, { id: "1", credential: CREDENTIAL, expiresAt: "2030-01-01T00:00:00Z" });
    });
    expect(result).toEqual({ ok: true, credential: CREDENTIAL });
    expect(calls[0]?.url).toBe(`${BASE}/api/auth/pairing-token`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${BEARER}`);
  });

  it("explains a missing bearer without calling the server", async () => {
    let called = false;
    const result = await mintPairingToken({ httpBaseUrl: BASE, bearerToken: null }, async () => {
      called = true;
      return json(200, {});
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });

  it.each([
    [401, {}],
    [403, { code: "insufficient_scope" }],
    [403, {}],
    [500, {}],
    [200, { nope: true }],
  ])("maps status %s to a one-line reason without secrets", async (status, body) => {
    const result = await mintPairingToken(server, async () => json(status, body));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain("\n");
      expect(result.reason).not.toContain(BEARER);
      expect(result.reason).not.toContain(CREDENTIAL);
    }
  });

  it("names the missing scope on 403 insufficient_scope", async () => {
    const result = await mintPairingToken(server, async () =>
      json(403, { code: "insufficient_scope" }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("access:write");
  });

  it("reports an unreachable server on a network error", async () => {
    const result = await mintPairingToken(server, async () => {
      throw new TypeError(`Network request failed for ${BEARER}`);
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unreachable");
      expect(result.reason).not.toContain(BEARER);
    }
  });

  it("gives distinct reasons for 401 and server errors", async () => {
    const unauthorized = await mintPairingToken(server, async () => json(401, {}));
    const failed = await mintPairingToken(server, async () => json(500, {}));
    expect(unauthorized).not.toEqual(failed);
  });
});

describe("probeFactory", () => {
  it("is ok for a JSON 2xx and sends the bearer", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await probeFactory(server, async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json(200, { enabled: true });
    });
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`${BASE}/api/factory/status`);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${BEARER}`);
  });

  it("says the server has no Factory pages on 404", async () => {
    const result = await probeFactory(server, async () => json(404, {}));
    expect(result).toEqual({ ok: false, reason: "This server has no Factory pages." });
  });

  it("says the same when a 200 is not JSON (SPA fallback)", async () => {
    const result = await probeFactory(
      server,
      async () =>
        new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    expect(result).toEqual({ ok: false, reason: "This server has no Factory pages." });
  });

  it.each([401, 403])("explains %s", async (status) => {
    const result = await probeFactory(server, async () => json(status, {}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain(BEARER);
  });

  it("reports an unreachable server on a network error", async () => {
    const result = await probeFactory(server, async () => {
      throw new TypeError("Network request failed");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unreachable");
  });
});

describe("factoryUrl", () => {
  it("joins a path onto a base with or without a trailing slash", () => {
    expect(factoryUrl("/factory", SLASH_BASE)).toBe("https://mac.tail1234.ts.net:3876/factory");
    expect(factoryUrl("/factory", BASE)).toBe(`${BASE}/factory`);
  });

  it("is used for the mint and probe requests", async () => {
    const urls: string[] = [];
    const slash = { httpBaseUrl: SLASH_BASE, bearerToken: BEARER };
    await mintPairingToken(slash, async (url) => {
      urls.push(url);
      return json(200, { credential: CREDENTIAL });
    });
    await probeFactory(slash, async (url) => {
      urls.push(url);
      return json(200, {});
    });
    expect(urls).toEqual([
      "https://mac.tail1234.ts.net:3876/api/auth/pairing-token",
      "https://mac.tail1234.ts.net:3876/api/factory/status",
    ]);
  });
});

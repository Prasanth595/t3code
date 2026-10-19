import { describe, expect, it } from "vite-plus/test";

import {
  factoryLinkAction,
  mintPairingToken,
  parseFactoryMessage,
  probeFactory,
  signInDecision,
} from "./factorySignIn";

const BASE = "https://mac.tail1234.ts.net";
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

describe("signInDecision", () => {
  it("signs in on the pair page, with or without a trailing slash", () => {
    expect(signInDecision({ type: "location", href: `${BASE}/pair` }, BASE, false)).toBe("sign-in");
    expect(signInDecision({ type: "location", href: `${BASE}/pair/#token=x` }, BASE, false)).toBe(
      "sign-in",
    );
  });

  it("signs in on a 401 from the status endpoint", () => {
    expect(signInDecision({ type: "unauthorized" }, BASE, false)).toBe("sign-in");
  });

  it("does nothing on the factory pages, other paths or other origins", () => {
    expect(signInDecision({ type: "location", href: `${BASE}/factory` }, BASE, false)).toBe(
      "ignore",
    );
    expect(signInDecision({ type: "location", href: `${BASE}/settings` }, BASE, false)).toBe(
      "ignore",
    );
    expect(
      signInDecision({ type: "location", href: "https://other.example/pair" }, BASE, false),
    ).toBe("ignore");
  });

  it("gives up instead of looping when a sign-in was already tried", () => {
    expect(signInDecision({ type: "location", href: `${BASE}/pair` }, BASE, true)).toBe("failed");
    expect(signInDecision({ type: "unauthorized" }, BASE, true)).toBe("failed");
    expect(signInDecision({ type: "location", href: `${BASE}/factory` }, BASE, true)).toBe(
      "ignore",
    );
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

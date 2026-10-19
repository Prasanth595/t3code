// Pure rules for the Factory screen: which links stay in the WebView, when to sign it
// in, and how the pairing-token and status requests map to one-line reasons. No reason
// ever carries the bearer or the minted credential.

export type FactoryServer = {
  readonly httpBaseUrl: string;
  readonly bearerToken: string | null;
};

export type FactoryFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type FactoryResult<T = object> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: string };

const REQUEST_TIMEOUT_MS = 15_000;
const UNREACHABLE = "The server is unreachable.";
const NO_FACTORY_PAGES = "This server has no Factory pages.";

/** Saved base URLs end in "/", so paths are resolved, never concatenated. */
export function factoryUrl(path: string, httpBaseUrl: string): string {
  return new URL(path, httpBaseUrl).toString();
}

export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Same-origin and in-page schemes stay in the WebView. Any other http(s) origin, and
 * schemes such as mailto: and tel:, go to the system.
 */
export function factoryLinkAction(url: string, httpBaseUrl: string): "webview" | "system" {
  if (url === "about:blank" || url.startsWith("blob:") || url.startsWith("data:")) {
    return "webview";
  }
  const origin = originOf(url);
  return origin !== null && origin === originOf(httpBaseUrl) ? "webview" : "system";
}

export type FactoryWebViewMessage =
  | { readonly type: "location"; readonly href: string }
  | { readonly type: "unauthorized" }
  | { readonly type: "exchange"; readonly ok: boolean };

export function parseFactoryMessage(data: string): FactoryWebViewMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.type === "location" && typeof message.href === "string") {
    return { type: "location", href: message.href };
  }
  if (message.type === "unauthorized") return { type: "unauthorized" };
  if (message.type === "exchange" && typeof message.ok === "boolean") {
    return { type: "exchange", ok: message.ok };
  }
  return null;
}

export type SignInState = "idle" | "minting" | "exchanging" | "exchanged" | "signed-in";
export type SignInEvent = FactoryWebViewMessage | { readonly type: "minted" };
export type SignInAction = "mint" | "rejected" | "exchange-failed" | "none";

const IDLE_NONE = { action: "none" } as const;

/**
 * One sign-in per unauthenticated signal. idle -> minting -> exchanging (credential
 * injected) -> exchanged (cookie set) -> signed-in (landed on /factory). A second
 * unauthenticated signal while exchanged is "rejected": the server took the credential but
 * the WebView is still unauthenticated, so Retry replaces a loop. Messages count only when
 * the WebView's top frame (eventUrl) is on the server's origin.
 */
export function nextSignIn(
  state: SignInState,
  event: SignInEvent,
  eventUrl: string,
  httpBaseUrl: string,
): { readonly state: SignInState; readonly action: SignInAction } {
  if (event.type === "minted") {
    return { state: state === "minting" ? "exchanging" : state, ...IDLE_NONE };
  }
  const serverOrigin = originOf(httpBaseUrl);
  if (serverOrigin === null || originOf(eventUrl) !== serverOrigin) return { state, ...IDLE_NONE };

  if (event.type === "exchange") {
    if (state !== "exchanging") return { state, ...IDLE_NONE };
    return event.ok
      ? { state: "exchanged", ...IDLE_NONE }
      : { state: "idle", action: "exchange-failed" };
  }

  let href: URL | null = null;
  if (event.type === "location") {
    try {
      href = new URL(event.href);
    } catch {
      return { state, ...IDLE_NONE };
    }
  }
  if (href !== null && href.origin === serverOrigin && /^\/factory(\/|$)/.test(href.pathname)) {
    return { state: state === "exchanged" ? "signed-in" : state, ...IDLE_NONE };
  }
  const unauthenticated =
    event.type === "unauthorized" ||
    (href !== null &&
      href.origin === serverOrigin &&
      (href.pathname === "/pair" || href.pathname === "/pair/"));
  if (!unauthenticated) return { state, ...IDLE_NONE };
  if (state === "minting" || state === "exchanging") return { state, ...IDLE_NONE };
  if (state === "exchanged") return { state: "idle", action: "rejected" };
  return { state: "minting", action: "mint" };
}

async function request(fetchFn: FactoryFetch, url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function authorized(server: FactoryServer, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${server.bearerToken ?? ""}`, ...extra };
}

const NOT_CONNECTED = "This environment is not connected yet.";

/** Mints a one-time pairing credential with the connection's bearer token. */
export async function mintPairingToken(
  server: FactoryServer,
  fetchFn: FactoryFetch,
): Promise<FactoryResult<{ readonly credential: string }>> {
  if (server.bearerToken === null) return { ok: false, reason: NOT_CONNECTED };
  let response: Response;
  try {
    response = await request(fetchFn, factoryUrl("/api/auth/pairing-token", server.httpBaseUrl), {
      method: "POST",
      headers: authorized(server, { "content-type": "application/json" }),
      body: "{}",
    });
  } catch {
    return { ok: false, reason: UNREACHABLE };
  }
  if (response.status === 401) {
    return { ok: false, reason: "The server no longer accepts this pairing." };
  }
  if (response.status === 403) {
    const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
    return {
      ok: false,
      reason:
        body?.code === "insufficient_scope"
          ? "This pairing cannot sign in the Factory pages: it lacks access:write."
          : "The server refused to sign in the Factory pages.",
    };
  }
  if (!response.ok)
    return { ok: false, reason: `The server failed to sign in (${response.status}).` };
  const body = (await response.json().catch(() => null)) as { credential?: unknown } | null;
  if (typeof body?.credential !== "string" || body.credential.length === 0) {
    return { ok: false, reason: "The server returned an unexpected sign-in response." };
  }
  return { ok: true, credential: body.credential };
}

/** Checks the server has Factory pages and accepts this connection. Mints nothing. */
export async function probeFactory(
  server: FactoryServer,
  fetchFn: FactoryFetch,
): Promise<FactoryResult> {
  if (server.bearerToken === null) return { ok: false, reason: NOT_CONNECTED };
  let response: Response;
  try {
    response = await request(fetchFn, factoryUrl("/api/factory/status", server.httpBaseUrl), {
      method: "GET",
      headers: authorized(server, { accept: "application/json" }),
    });
  } catch {
    return { ok: false, reason: UNREACHABLE };
  }
  if (response.status === 404) return { ok: false, reason: NO_FACTORY_PAGES };
  if (response.status === 401) {
    return { ok: false, reason: "The server no longer accepts this pairing." };
  }
  if (response.status === 403) {
    return { ok: false, reason: "This pairing cannot read the Factory status." };
  }
  if (!response.ok)
    return { ok: false, reason: `The server returned an error (${response.status}).` };
  const body = await response.json().catch(() => undefined);
  return body === undefined ? { ok: false, reason: NO_FACTORY_PAGES } : { ok: true };
}

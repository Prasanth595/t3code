/**
 * Fork: per-origin request headers on mobile, for example a Cloudflare Access
 * service token. The connection catalog stores them (`requestHeaders`), and the
 * catalog store pushes each loaded or saved list here, so the transports read
 * them without a round trip through the storage layer.
 *
 * Known limit: React Native fetch, expo-image and expo-file-system keep custom
 * headers when they follow a redirect to another origin, and React Native has
 * no working `redirect: "manual"`. Only the saved server or Cloudflare Access
 * in front of it can redirect today. Revisit if a server can redirect to a
 * third party.
 */
import {
  type ConnectionTransientError,
  isCloudflareAccessChallenge,
  type OriginRequestHeaders,
  RequestHeaderStore,
  requestHeaderOrigin,
  requestHeadersForUrl,
} from "@t3tools/client-runtime/connection";
import {
  type ConnectionCatalogDocument,
  setRequestHeadersInCatalog,
} from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";

let rules: ReadonlyArray<OriginRequestHeaders> = [];

export function setRequestHeaderRules(next: ReadonlyArray<OriginRequestHeaders>): void {
  rules = next;
}

/** The store of the headers, kept in the connection catalog of `storage.ts`. */
export function makeRequestHeaderStore(catalog: {
  readonly read: Effect.Effect<ConnectionCatalogDocument, ConnectionTransientError>;
  readonly update: (
    transform: (document: ConnectionCatalogDocument) => ConnectionCatalogDocument,
  ) => Effect.Effect<void, ConnectionTransientError>;
}) {
  return RequestHeaderStore.of({
    get: (origin) =>
      catalog.read.pipe(
        Effect.map(
          (document) =>
            document.requestHeaders.find((value) => value.origin === origin)?.headers ?? [],
        ),
      ),
    set: (origin, headers) =>
      catalog.update((document) => setRequestHeadersInCatalog(document, origin, headers)),
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isCloudflareAccessResponse(response: Response): boolean {
  // fetch follows the login redirect, so the challenge shows as the final URL.
  // React Native does not set `response.redirected`, so only the URL counts.
  try {
    if (new URL(response.url).hostname.endsWith(".cloudflareaccess.com")) return true;
  } catch {
    // An empty or unparsable final URL is not a Cloudflare login.
  }
  const { status } = response;
  // Only a redirect, 401 or 403 can be a challenge; skip copying the headers otherwise.
  if (!(status >= 300 && status < 400) && status !== 401 && status !== 403) return false;
  return isCloudflareAccessChallenge(status, Object.fromEntries(response.headers));
}

/** The headers for the origin of `url` as a record, or undefined when it has none. */
export function requestHeadersRecord(url: string): Record<string, string> | undefined {
  const extra = requestHeadersForUrl(rules, url);
  if (extra.length === 0) return undefined;
  return Object.fromEntries(extra.map((header) => [header.name, header.value]));
}

/**
 * An image source with the headers of its origin. Native image loaders bypass
 * fetch, so they need the headers in the source itself.
 */
export function withRequestHeaders<Source extends { readonly uri: string }>(
  source: Source,
): Source | (Source & { readonly headers: Record<string, string> }) {
  const headers = requestHeadersRecord(source.uri);
  return headers === undefined ? source : { ...source, headers };
}

// Origins whose last response was a Cloudflare Access login. The request still
// fails as before; screens read this to say why and to offer the token fields.
const challengedOrigins = new Set<string>();

/** True when the last response from the origin of `url` was a Cloudflare Access login. */
export function isCloudflareAccessChallenged(url: string): boolean {
  const origin = requestHeaderOrigin(url);
  return origin !== null && challengedOrigins.has(origin);
}

/** `fetch` that adds the headers of the request origin and records Access logins. */
export const fetchWithRequestHeaders: typeof fetch = async (input, init) => {
  const url = requestUrl(input);
  const extra = requestHeadersForUrl(rules, url);
  let response: Response;
  if (extra.length === 0) {
    response = await fetch(input, init);
  } else {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const header of extra) headers.set(header.name, header.value);
    response = await fetch(input, { ...init, headers });
  }
  const origin = requestHeaderOrigin(url);
  if (origin !== null) {
    if (isCloudflareAccessResponse(response)) challengedOrigins.add(origin);
    else challengedOrigins.delete(origin);
  }
  return response;
};

// React Native's WebSocket takes handshake headers as a third argument. The DOM
// type this project compiles against does not declare it.
const NativeWebSocket = WebSocket as unknown as new (
  url: string,
  protocols: string | Array<string> | null,
  options: { readonly headers: Record<string, string> },
) => WebSocket;

/**
 * Effect WebSocket constructor that adds the headers of the URL origin. React
 * Native takes handshake headers as a third argument. Like Effect's global
 * constructor, it rejects platform client options.
 */
export const layerWebSocketConstructor = Layer.succeed(Socket.WebSocketConstructor)((
  url,
  options,
) => {
  if (options !== undefined && typeof options !== "string" && !Array.isArray(options)) {
    throw new TypeError("WebSocket client options are not supported on mobile.");
  }
  const headers = requestHeadersRecord(url);
  if (headers === undefined) return new WebSocket(url, options);
  return new NativeWebSocket(url, options ?? null, { headers });
});

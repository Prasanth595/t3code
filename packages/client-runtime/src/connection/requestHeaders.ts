import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ConnectionTransientError } from "./model.ts";

/**
 * Extra request headers that the desktop app adds to every request to one
 * origin, for example a Cloudflare Access service token. Values are secrets.
 */
export const RequestHeader = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
});
export type RequestHeader = typeof RequestHeader.Type;

export const OriginRequestHeaders = Schema.Struct({
  /** An http(s) origin such as `https://t3.example.com`. WebSocket URLs map to it. */
  origin: Schema.String,
  headers: Schema.Array(RequestHeader),
});
export type OriginRequestHeaders = typeof OriginRequestHeaders.Type;

export const CLOUDFLARE_ACCESS_CLIENT_ID_HEADER = "CF-Access-Client-Id";
export const CLOUDFLARE_ACCESS_CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";
export const CLOUDFLARE_ACCESS_MESSAGE =
  "This server is behind Cloudflare Access. Add a service token under Request headers.";

export const MAX_REQUEST_HEADERS = 16;
const MAX_REQUEST_HEADER_NAME_LENGTH = 128;
const MAX_REQUEST_HEADER_VALUE_LENGTH = 4096;

// The browser or the transport owns these, or they carry the app's own credentials.
const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);
const FORBIDDEN_REQUEST_HEADER_PREFIXES = ["proxy-", "sec-"];
const TOKEN_SYMBOLS = "!#$%&'*+-.^_`|~";

function isTokenChar(char: string): boolean {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    TOKEN_SYMBOLS.includes(char)
  );
}

// RFC 9110 field-value: visible ASCII, space, and tab. No CR, LF, or NUL.
function isFieldValueChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code === 0x09 || (code >= 0x20 && code <= 0x7e);
}

/** Returns why `headers` cannot be sent, or null when every header is valid. */
export function requestHeadersError(headers: ReadonlyArray<RequestHeader>): string | null {
  if (headers.length > MAX_REQUEST_HEADERS) {
    return `Use at most ${MAX_REQUEST_HEADERS} request headers.`;
  }
  const seen = new Set<string>();
  for (const { name, value } of headers) {
    if (name.length === 0) return "Enter a header name.";
    if (name.length > MAX_REQUEST_HEADER_NAME_LENGTH) {
      return `Header names can have at most ${MAX_REQUEST_HEADER_NAME_LENGTH} characters.`;
    }
    if (![...name].every(isTokenChar)) {
      return `"${name}" is not a valid header name.`;
    }
    const lowerName = name.toLowerCase();
    if (
      FORBIDDEN_REQUEST_HEADERS.has(lowerName) ||
      FORBIDDEN_REQUEST_HEADER_PREFIXES.some((prefix) => lowerName.startsWith(prefix))
    ) {
      return `"${name}" cannot be set here.`;
    }
    if (seen.has(lowerName)) return `"${name}" is set more than once.`;
    seen.add(lowerName);
    if (value.length === 0) return `Enter a value for "${name}".`;
    if (value.length > MAX_REQUEST_HEADER_VALUE_LENGTH) {
      return `Header values can have at most ${MAX_REQUEST_HEADER_VALUE_LENGTH} characters.`;
    }
    if (![...value].every(isFieldValueChar)) {
      return `The value of "${name}" contains characters that a header cannot carry.`;
    }
  }
  return null;
}

/**
 * The http(s) origin that request headers for `url` are stored under. A
 * WebSocket URL maps to the origin of its HTTP scheme. Returns null for any
 * other scheme or an unparsable URL.
 */
export function requestHeaderOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const protocol =
    parsed.protocol === "ws:" ? "http:" : parsed.protocol === "wss:" ? "https:" : parsed.protocol;
  if (protocol !== "http:" && protocol !== "https:") return null;
  // `host` omits the default port of the original scheme, which is also the
  // default port of the mapped scheme (ws/http 80, wss/https 443).
  return `${protocol}//${parsed.host}`;
}

/** The headers for the origin of `url`. Other origins never get them. */
export function requestHeadersForUrl(
  rules: ReadonlyArray<OriginRequestHeaders>,
  url: string,
): ReadonlyArray<RequestHeader> {
  const origin = requestHeaderOrigin(url);
  if (origin === null) return [];
  return rules.find((rule) => rule.origin === origin)?.headers ?? [];
}

function headerValues(
  headers: Readonly<Record<string, string | ReadonlyArray<string>>>,
  name: string,
): ReadonlyArray<string> {
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string") values.push(value);
    else values.push(...value);
  }
  return values;
}

function isCloudflareAccessHost(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}

/**
 * True when a response is Cloudflare Access asking for a login: a redirect
 * to `*.cloudflareaccess.com`, or a 401/403 that carries `cf-access-*` headers.
 */
export function isCloudflareAccessChallenge(
  statusCode: number,
  headers: Readonly<Record<string, string | ReadonlyArray<string>>>,
): boolean {
  if (statusCode >= 300 && statusCode < 400) {
    return headerValues(headers, "location").some(isCloudflareAccessHost);
  }
  if (statusCode === 401 || statusCode === 403) {
    return Object.keys(headers).some((name) => name.toLowerCase().startsWith("cf-access-"));
  }
  return false;
}

/** A Cloudflare Access service token, as the two headers that carry it. */
export interface CloudflareAccessServiceToken {
  readonly clientId: string;
  readonly clientSecret: string;
}

function isHeaderName(header: RequestHeader, name: string): boolean {
  return header.name.toLowerCase() === name.toLowerCase();
}

/** The service token in `headers`, or null when either of its headers is missing. */
export function cloudflareAccessServiceToken(
  headers: ReadonlyArray<RequestHeader>,
): CloudflareAccessServiceToken | null {
  const clientId = headers.find((header) =>
    isHeaderName(header, CLOUDFLARE_ACCESS_CLIENT_ID_HEADER),
  )?.value;
  const clientSecret = headers.find((header) =>
    isHeaderName(header, CLOUDFLARE_ACCESS_CLIENT_SECRET_HEADER),
  )?.value;
  return clientId === undefined || clientSecret === undefined ? null : { clientId, clientSecret };
}

/** `headers` with their service token replaced by `token`. A null token removes it. */
export function withCloudflareAccessServiceToken(
  headers: ReadonlyArray<RequestHeader>,
  token: CloudflareAccessServiceToken | null,
): ReadonlyArray<RequestHeader> {
  const others = headers.filter(
    (header) =>
      !isHeaderName(header, CLOUDFLARE_ACCESS_CLIENT_ID_HEADER) &&
      !isHeaderName(header, CLOUDFLARE_ACCESS_CLIENT_SECRET_HEADER),
  );
  return token === null
    ? others
    : [
        { name: CLOUDFLARE_ACCESS_CLIENT_ID_HEADER, value: token.clientId },
        { name: CLOUDFLARE_ACCESS_CLIENT_SECRET_HEADER, value: token.clientSecret },
        ...others,
      ];
}

/**
 * Extra request headers per origin, kept in the connection catalog. The desktop
 * app applies them in its main process (`ElectronRequestHeaders`); the mobile
 * app applies them in its fetch and WebSocket constructor.
 */
export class RequestHeaderStore extends Context.Service<
  RequestHeaderStore,
  {
    readonly get: (
      origin: string,
    ) => Effect.Effect<ReadonlyArray<RequestHeader>, ConnectionTransientError>;
    /** Replaces the headers of `origin`. An empty list removes them. */
    readonly set: (
      origin: string,
      headers: ReadonlyArray<RequestHeader>,
    ) => Effect.Effect<void, ConnectionTransientError>;
  }
>()("@t3tools/client-runtime/connection/requestHeaders/RequestHeaderStore") {}

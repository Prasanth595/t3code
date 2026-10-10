import {
  isCloudflareAccessChallenge,
  type OriginRequestHeaders,
  requestHeaderOrigin,
  requestHeadersError,
  requestHeadersForUrl,
} from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import * as Electron from "electron";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The main window uses the default session. The renderer cannot set headers
// on a WebSocket handshake, and custom headers on fetch trigger CORS
// preflights, so the main process adds them to every request instead.

const decodeCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionCatalogDocument));

let rules: ReadonlyArray<OriginRequestHeaders> = [];
// Origins whose last response was a Cloudflare Access login challenge.
const accessChallengedOrigins = new Set<string>();
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  const webRequest = Electron.session.defaultSession.webRequest;
  webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = requestHeadersForUrl(rules, details.url);
    if (headers.length === 0) {
      callback({});
      return;
    }
    const requestHeaders = { ...details.requestHeaders };
    for (const { name, value } of headers) requestHeaders[name] = value;
    callback({ requestHeaders });
  });
  webRequest.onHeadersReceived((details, callback) => {
    const origin = requestHeaderOrigin(details.url);
    if (origin !== null) {
      if (isCloudflareAccessChallenge(details.statusCode, details.responseHeaders ?? {})) {
        accessChallengedOrigins.add(origin);
      } else {
        accessChallengedOrigins.delete(origin);
      }
    }
    callback({});
  });
}

/**
 * Replaces the header rules with the ones in a raw connection catalog. A
 * catalog that does not decode clears them. Returns the origins whose rules
 * were invalid and skipped. Never returns or logs header values.
 */
export function applyConnectionCatalog(raw: string | null): ReadonlyArray<string> {
  install();
  const document = raw === null ? Option.none() : decodeCatalog(raw);
  const all = Option.match(document, {
    onNone: () => [],
    onSome: (value) => value.requestHeaders,
  });
  const skipped: string[] = [];
  rules = all.filter((rule) => {
    const valid =
      requestHeaderOrigin(rule.origin) === rule.origin &&
      requestHeadersError(rule.headers) === null;
    if (!valid) skipped.push(rule.origin);
    return valid;
  });
  return skipped;
}

/** True when the last response from the origin of `url` was a Cloudflare Access challenge. */
export function isCloudflareAccessChallenged(url: string): boolean {
  const origin = requestHeaderOrigin(url);
  return origin !== null && accessChallengedOrigins.has(origin);
}

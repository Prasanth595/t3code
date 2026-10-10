// Fork: cookies for sibling environments behind a proxy such as Cloudflare
// Access, which answers a request without its own cookie with a login redirect.
//
// This leaks nothing new: the browser sends only cookies that it already holds
// for the target host, and it exposes the response only when the target server
// lists the page origin with credentials (T3CODE_TRUSTED_BROWSER_ORIGINS). The
// page's own server must also list the target, so cookies stay off until the
// user opts in on the servers. Without that gate, a sibling server that keeps
// the wildcard CORS would reject every credentialed request.

// Origins that the page's own server trusts (its `trustedBrowserOrigins`).
// Empty until the primary server config arrives.
// Limit: a remote request before that config loads goes without cookies and
// fails once; the connection retry then succeeds. Revisit when that first
// failure shows in the UI.
let trustedOrigins: ReadonlySet<string> = new Set();

/** Set from the page's primary server config. An empty list turns cookies off. */
export const setCredentialedSiblingOrigins = (origins: ReadonlyArray<string>): void => {
  trustedOrigins = new Set(origins);
};

interface PageLocation {
  readonly protocol: string;
  readonly hostname: string;
}

/**
 * Whether `url` is an https sibling of the page: both https and the last two
 * hostname labels match (`t3-vps.example.com` and `t3-mac.example.com`).
 *
 * Limit: a two-label check treats hosts under a multi-part public suffix such
 * as `co.uk` as siblings of every other `co.uk` site. Revisit with a public
 * suffix list when a user runs environments under such a suffix.
 */
export const isSiblingOfPage = (url: string, page: PageLocation | undefined): boolean => {
  if (page === undefined || page.protocol !== "https:") return false;
  const target = URL.parse(url);
  if (target === null || target.protocol !== "https:") return false;
  const domain = registrableDomain(target.hostname);
  return domain !== null && domain === registrableDomain(page.hostname);
};

const registrableDomain = (hostname: string): string | null => {
  const labels = hostname.toLowerCase().split(".");
  return labels.length < 2 ? null : labels.slice(-2).join(".");
};

/** Whether a request to `url` sends cookies: only to a trusted sibling of the page. */
export const sendsSiblingCredentials = (
  url: string,
  page: PageLocation | undefined = globalThis.location,
): boolean => {
  const origin = URL.parse(url)?.origin;
  return origin !== undefined && trustedOrigins.has(origin) && isSiblingOfPage(url, page);
};

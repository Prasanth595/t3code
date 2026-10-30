/** A resolved CLIProxyAPI endpoint for one provider instance. Secrets are already filled in. */
export interface ProviderProxyRoute {
  /** Origin plus any base path, without a trailing slash or `/v1`. */
  readonly url: string;
  readonly apiKey: string;
}

/** Accepts the forms users paste: with or without a trailing slash or `/v1`. */
export const normalizeProviderProxyUrl = (url: string): string =>
  url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");

/** The OpenAI- and Anthropic-compatible API root. */
export const providerProxyApiUrl = (route: ProviderProxyRoute): string => `${route.url}/v1`;

export const PROXY_AUTH_METADATA = { type: "proxy", label: "Via proxy" } as const;

// The harness never sees which pooled account served a request, so it cannot report limits.
export const PROXY_LIMITS_MESSAGE =
  "This instance uses the proxy's accounts. Add the proxy's management key to see them under Limits.";

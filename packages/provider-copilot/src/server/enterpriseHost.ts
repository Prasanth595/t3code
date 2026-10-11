/**
 * Enterprise host and URI normalization utilities for GitHub Copilot.
 *
 * @module provider-copilot/server/enterpriseHost
 */

export function normalizeEnterpriseHost(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return url.hostname.toLowerCase();
    } catch {
      // Fall through to regex stripping
    }
  }
  return trimmed
    .replace(/^[a-zA-Z]+:\/\//, "")
    .replace(/[/?:#].*$/, "")
    .replace(/:\d+$/, "")
    .toLowerCase();
}

function isGitHubDotCom(host: string): boolean {
  return host === "" || host === "github.com";
}

/** Whether a normalized host represents any GitHub Enterprise instance. */
export function isEnterpriseHost(host: string): boolean {
  return !isGitHubDotCom(host);
}

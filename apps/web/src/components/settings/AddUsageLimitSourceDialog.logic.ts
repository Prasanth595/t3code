import { UsageLimitSourceId } from "@t3tools/contracts";

/**
 * Dots and dashes in the host are kept so `foo-bar.com` and `foo.bar.com` do
 * not collide; anything else (a port's colon, a path) is folded to a dash.
 */
export function sourceIdFromUrl(url: string, existingIds: ReadonlySet<string>): UsageLimitSourceId {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {}
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Settings merge by ID, so adding a hub must not replace an existing entry.
  const base = `cliproxy-${slug || "hub"}`;
  let id = base;
  for (let suffix = 2; existingIds.has(id); suffix += 1) {
    id = `${base}-${suffix}`;
  }
  return UsageLimitSourceId.make(id);
}

